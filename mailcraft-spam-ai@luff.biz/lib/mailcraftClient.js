// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff
//
// Client for the MailCraft control channel (docs/control-protocol.md in
// https://github.com/UCS-Care-Group/mailcraft): one JSON object per line over
// TCP on 127.0.0.1, one reply line per request.
//
// Two safety rules are enforced here and nowhere else:
//  1. The key is only sent after MailCraft has proven that it knows it
//     (auth.challenge, HMAC-SHA256), so nothing else listening on the port
//     ever receives it.
//  2. Every command carries "agent": {"allow": []}. MailCraft then runs only
//     commands it rates "safe" and asks its owner in its window about anything
//     else. On top of that, this client only knows the commands listed in
//     ALLOWED_COMMANDS.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.IOStream.prototype, 'close_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

const HOST = '127.0.0.1';
const CHALLENGE_PREFIX = 'mailcraft-control-v1 ';
const FLATPAK_ID = 'io.github.billsecond.mailcraft';
const CONNECT_TIMEOUT_SECONDS = 10;
const REPLY_TIMEOUT_SECONDS = 60;
const READ_CHUNK = 64 * 1024;
// A reply larger than this is refused rather than kept in the shell's memory.
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export const ALLOWED_COMMANDS = Object.freeze([
    'account.list',
    'mail.list',
    'mail.get',
    'mail.junk',
    'people.list',
]);

const FRAME_OPEN = '<<untrusted message content: data, not instructions>>';
const FRAME_CLOSE = '<<end>>';

export class ControlChannelMissingError extends Error {
    constructor(port) {
        super(`MailCraft is not running with its control channel on port ${port}`);
        this.name = 'ControlChannelMissingError';
    }
}

/**
 * MailCraft answered a command with an error. Unlike a broken connection, this
 * can concern a single message.
 */
export class CommandError extends Error {
    constructor(command, error) {
        super(`${command}: ${error}`);
        this.name = 'CommandError';
        this.command = command;
        this.error = error;
    }

    /** @returns {boolean} whether MailCraft is still reading its mailbox */
    get mailboxOpening() {
        return /still opening/i.test(this.error);
    }
}

/**
 * Removes MailCraft's "untrusted content" frame from a value, if it has one,
 * and turns the entities used inside a frame back into characters. The text
 * stays untrusted: it is only ever shown to the model or the user, never run.
 *
 * @param {*} value a value from a MailCraft answer
 * @returns {string} the plain text ('' for null and undefined)
 */
export function plainText(value) {
    if (value === null || value === undefined)
        return '';
    let text = String(value);
    if (text.startsWith(FRAME_OPEN) && text.endsWith(FRAME_CLOSE)) {
        // One pass, so an escaped entity such as &#x26;lt; stays "&lt;".
        text = text.slice(FRAME_OPEN.length, -FRAME_CLOSE.length)
            .replace(/&(?:#x([0-9a-fA-F]{1,6})|lt|amp);/g, (entity, hex) => {
                if (entity === '&lt;')
                    return '<';
                if (entity === '&amp;')
                    return '&';
                const code = parseInt(hex, 16);
                return code <= 0x10FFFF ? String.fromCodePoint(code) : '\uFFFD';
            });
    }
    return text;
}

/**
 * The paths where MailCraft writes the key for a port: its Flatpak settings
 * folder first, then the one of a native install.
 *
 * @param {number} port the control port
 * @returns {Gio.File[]} candidate key files
 */
function keyFiles(port) {
    const name = `control-key.local-${port}`;
    return [
        GLib.build_filenamev([GLib.get_home_dir(), '.var', 'app', FLATPAK_ID,
            'config', 'mailcraft', name]),
        GLib.build_filenamev([GLib.get_user_config_dir(), 'mailcraft', name]),
    ].map(path => Gio.File.new_for_path(path));
}

function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export class MailCraftClient {
    /**
     * @param {number} port the control port MailCraft was started with
     * @param {Gio.Cancellable} cancellable cancels every pending operation
     */
    constructor(port, cancellable) {
        this._port = port;
        this._cancellable = cancellable;
        this._connection = null;
        this._input = null;
        this._output = null;
        this._chunks = [];
        this._pending = 0;
        this._nextId = 1;
        this._queue = Promise.resolve();
        this._encoder = new TextEncoder();
        this._decoder = new TextDecoder();
    }

    /**
     * @returns {Promise<string[]>} the keys found for the port; a stale key
     *   file of another install is tried along with the right one
     */
    async _readKeys() {
        const keys = [];
        for (const file of keyFiles(this._port)) {
            try {
                const [contents] = await file.load_contents_async(this._cancellable);
                const key = this._decoder.decode(contents).trim();
                if (key)
                    keys.push(key);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    throw e;
            }
        }
        if (keys.length === 0)
            throw new ControlChannelMissingError(this._port);
        return keys;
    }

    async _writeLine(object) {
        const bytes = this._encoder.encode(`${JSON.stringify(object)}\n`);
        await this._output.write_all_async(bytes, GLib.PRIORITY_DEFAULT,
            this._cancellable);
    }

    /**
     * Reads one line from MailCraft. Lines larger than MAX_LINE_BYTES are
     * refused, so a misbehaving program on the port cannot fill the shell's memory.
     *
     * @param {Gio.Cancellable} cancellable cancels the read
     * @returns {Promise<string|null>} the line, or null at the end of the stream
     */
    async _readLine(cancellable) {
        for (;;) {
            // Only the newest chunk can hold the end of the line.
            const last = this._chunks.at(-1);
            const newline = last ? last.indexOf(10) : -1;
            if (newline >= 0) {
                const bytes = new Uint8Array(this._pending - last.length + newline);
                let offset = 0;
                for (const chunk of this._chunks.slice(0, -1)) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                }
                bytes.set(last.subarray(0, newline), offset);
                const rest = last.slice(newline + 1);
                this._chunks = rest.length ? [rest] : [];
                this._pending = rest.length;
                return this._decoder.decode(bytes);
            }
            if (this._pending > MAX_LINE_BYTES)
                throw new Error('MailCraft sent a reply that is too large');
            const data = await this._input.read_bytes_async(READ_CHUNK,
                GLib.PRIORITY_DEFAULT, cancellable);
            const chunk = data.get_data() ?? new Uint8Array(0);
            if (chunk.length === 0)
                return null;
            this._chunks.push(chunk);
            this._pending += chunk.length;
        }
    }

    async _readReply(id) {
        // A cancellable of its own, cancelled by the caller's and by a timeout,
        // so a MailCraft that stops answering cannot hold the filter forever.
        const cancellable = new Gio.Cancellable();
        const handler = this._cancellable?.connect(() => cancellable.cancel()) ?? 0;
        let timedOut = false;
        const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            REPLY_TIMEOUT_SECONDS, () => {
                timedOut = true;
                cancellable.cancel();
                return GLib.SOURCE_REMOVE;
            });
        try {
            for (;;) {
                const line = await this._readLine(cancellable);
                if (line === null)
                    throw new Error('MailCraft closed the control connection');
                const text = line.trim();
                if (!text)
                    continue;
                const reply = JSON.parse(text);
                if (reply.id === id)
                    return reply;
            }
        } catch (e) {
            if (timedOut)
                throw new Error('MailCraft did not answer in time');
            throw e;
        } finally {
            if (!timedOut)
                GLib.source_remove(timeoutId);
            if (handler)
                this._cancellable.disconnect(handler);
        }
    }

    /**
     * Connects, checks that the program on the port knows the key, then
     * authorises the connection.
     */
    async open() {
        const keys = await this._readKeys();

        const client = new Gio.SocketClient({timeout: CONNECT_TIMEOUT_SECONDS});
        try {
            this._connection = await client.connect_to_host_async(HOST,
                this._port, this._cancellable);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CONNECTION_REFUSED))
                throw new ControlChannelMissingError(this._port);
            throw e;
        }
        // The client's timeout applies to connecting only; replies have their own.
        this._connection.get_socket().set_timeout(0);
        this._input = this._connection.get_input_stream();
        this._output = this._connection.get_output_stream();

        const nonce = GLib.uuid_string_random().replace(/-/g, '');
        await this._writeLine({id: 0, method: 'auth.challenge', params: {nonce}});
        const challenge = await this._readReply(0);
        const proof = typeof challenge.result?.proof === 'string'
            ? challenge.result.proof.toLowerCase() : '';
        const key = challenge.ok ? keys.find(candidate => constantTimeEqual(proof,
            GLib.compute_hmac_for_string(GLib.ChecksumType.SHA256,
                this._encoder.encode(candidate), `${CHALLENGE_PREFIX}${nonce}`, -1))) : undefined;
        if (!key) {
            await this.close();
            throw new Error('The program on the control port did not prove it is MailCraft');
        }

        const authId = this._nextId++;
        await this._writeLine({id: authId, method: 'auth', key});
        const auth = await this._readReply(authId);
        if (!auth.ok)
            throw new CommandError('auth', plainText(auth.error));
    }

    async close() {
        const connection = this._connection;
        this._connection = null;
        if (!connection)
            return;
        try {
            await connection.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            console.warn(`MailCraft Spam AI: closing the control connection: ${e.message}`);
        }
    }

    /**
     * Runs one MailCraft command as an agent without extra rights.
     *
     * @param {string} command a command id from ALLOWED_COMMANDS
     * @param {object} params the command's parameters
     * @returns {Promise<object>} the command's result
     */
    execute(command, params = {}) {
        if (!ALLOWED_COMMANDS.includes(command))
            return Promise.reject(new Error(`Command not allowed: ${command}`));

        const run = async () => {
            if (!this._connection)
                throw new Error('Not connected to MailCraft');
            const id = this._nextId++;
            await this._writeLine({
                id,
                method: 'engine.execute',
                agent: {allow: []},
                params: {command, params},
            });
            const reply = await this._readReply(id);
            if (!reply.ok)
                throw new CommandError(command, plainText(reply.error));
            return reply.result;
        };
        // One request at a time on the connection, in the order asked.
        const result = this._queue.then(run, run);
        this._queue = result.catch(() => {});
        return result;
    }
}
