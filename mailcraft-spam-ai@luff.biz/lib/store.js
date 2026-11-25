// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff
//
// What the extension keeps on disk, in its own folder under
// $XDG_STATE_HOME (~/.local/state/mailcraft-spam-ai@luff.biz/):
//  - log.json: the last LOG_LIMIT checks, newest first. Older entries are
//    dropped on each write. Holds sender, subject and the model's reason, so
//    it stays on this computer and is never sent anywhere.
//  - state.json: per MailCraft account, when the filter was turned on and the
//    ids of the messages already handled, so only mail that arrives after the
//    filter was turned on is checked, and each message only once.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'make_directory_async');

export const LOG_LIMIT = 100;

/**
 * Creates a folder and any missing parents, like `mkdir -p`, without blocking.
 *
 * @param {Gio.File} dir the folder
 */
async function makeDirectory(dir) {
    try {
        await dir.make_directory_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            return;
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) || !dir.get_parent())
            throw e;
        await makeDirectory(dir.get_parent());
        await makeDirectory(dir);
    }
}

export class Store {
    /**
     * @param {string} uuid the extension's uuid, used as folder name
     */
    constructor(uuid) {
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_state_dir(), uuid]));
        this._encoder = new TextEncoder();
        this._decoder = new TextDecoder();
        this._writes = Promise.resolve();
    }

    async _read(name, fallback) {
        try {
            const [contents] = await this._dir.get_child(name).load_contents_async(null);
            return JSON.parse(this._decoder.decode(contents));
        } catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)))
                console.error(`MailCraft Spam AI: reading ${name}: ${e.message}`);
            return fallback;
        }
    }

    _write(name, value) {
        const write = async () => {
            await makeDirectory(this._dir);
            const bytes = new GLib.Bytes(this._encoder.encode(JSON.stringify(value)));
            await this._dir.get_child(name).replace_contents_bytes_async(bytes, null,
                false, Gio.FileCreateFlags.PRIVATE, null);
        };
        // Writes run one after the other, so a slow write never overtakes a later one.
        this._writes = this._writes.then(write, write);
        return this._writes;
    }

    /** @returns {Promise<object[]>} the log, newest first */
    readLog() {
        return this._read('log.json', []);
    }

    /**
     * @param {object} entry one check: time, from, subject, spamValue, explanation,
     *   moved, truncated, skipped or error
     */
    async appendLog(entry) {
        const log = await this.readLog();
        log.unshift(entry);
        await this._write('log.json', log.slice(0, LOG_LIMIT));
    }

    clearLog() {
        return this._write('log.json', []);
    }

    /** @returns {Promise<{accounts: object}>} per account: {since, done} */
    async readState() {
        const state = await this._read('state.json', {});
        state.accounts ??= {};
        return state;
    }

    writeState(state) {
        return this._write('state.json', state);
    }
}
