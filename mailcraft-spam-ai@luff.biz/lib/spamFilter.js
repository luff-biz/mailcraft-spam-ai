// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff
//
// The filter itself. Every few minutes it looks at the inbox of each chosen
// MailCraft account, takes the mail that arrived since the filter was turned
// on and has not been handled yet, and for each message, one after the other
// (as ThunderAI does):
//   trusted and verified sender? -> leave it, note it in the log
//   otherwise                    -> ask the model; at or above the threshold -> mail.junk
// Any error leaves the message where it is. If MailCraft or the model cannot
// be reached, the round ends and the message is tried again next round. An
// error that concerns one message only (the model's answer, a refused request,
// a MailCraft error for that message) counts as an attempt; after
// MAX_ATTEMPTS the message is given up and stays in the inbox. The model's
// answer is only ever read as a number and a reason: nothing in it becomes a
// command, an id or a folder.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import {CommandError, ControlChannelMissingError, MailCraftClient, plainText} from './mailcraftClient.js';
import {HttpError, LlmClient, VerdictError} from './llmClient.js';
import {buildPrompt} from './prompt.js';

const LIST_LIMIT = 500;
const MAX_ATTEMPTS = 3;
// Handled message ids kept per account. Ids of mail that left the inbox stay
// in the list, so a message the user takes back out of junk is not checked
// again. Beyond this number the oldest ids no longer in the inbox are dropped.
const DONE_LIMIT = 5000;

export const FilterState = Object.freeze({
    OFF: 'off',
    IDLE: 'idle',
    CHECKING: 'checking',
    NO_CONTROL: 'no-control',
    ERROR: 'error',
});

const ADDRESS = /[^\s<>"(),;:]+@[^\s<>"(),;:]+/g;

/**
 * @param {string} from a From value such as `Name <user@example.org>`
 * @returns {string} the address in lower case, or ''. With several angle
 *   brackets the last one is the address; the ones before belong to the name.
 */
export function senderAddress(from) {
    const text = plainText(from);
    const angles = [...text.matchAll(/<([^<>@\s]+@[^<>\s]+)>/g)];
    if (angles.length > 0)
        return angles.at(-1)[1].toLowerCase();
    return (text.match(ADDRESS) ?? [''])[0].toLowerCase();
}

/**
 * @param {string} text a To or Cc value
 * @returns {string[]} the addresses in it, in lower case
 */
export function addressesIn(text) {
    return (plainText(text).match(ADDRESS) ?? []).map(a => a.toLowerCase());
}

/**
 * @param {string} address the sender's address in lower case
 * @param {string[]} entries user@example.org or @example.org entries
 * @returns {boolean} whether an entry matches
 */
export function matchesSkipList(address, entries) {
    if (!address)
        return false;
    const domain = address.slice(address.lastIndexOf('@'));
    return entries.some(raw => {
        const entry = raw.trim().toLowerCase().replace(/^\*@/, '@');
        return entry && (entry === address || (entry.startsWith('@') && entry === domain));
    });
}

/**
 * @param {string} a a domain in lower case
 * @param {string} b another domain in lower case
 * @returns {boolean} whether one is the other or a subdomain of it
 */
function aligned(a, b) {
    return Boolean(a && b) && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

/**
 * Whether the sender of a message is who it says, as far as the receiving
 * server and MailCraft can tell. A trusted sender is only skipped when this
 * holds, so a forged From of a contact is still checked.
 *
 * @param {object} full the answer of MailCraft's mail.get
 * @param {string} address the sender's address in lower case
 * @returns {boolean} DMARC passed, or without a DMARC result a DKIM signature
 *   of the sender's own domain passed; and MailCraft has no warning about
 *   the sender. SPF alone is not enough: it vouches for the envelope sender,
 *   not for the address shown.
 */
export function senderVerified(full, address) {
    const warnings = Array.isArray(full?.warnings) ? full.warnings : [];
    if (warnings.some(w => w?.level === 'warning'))
        return false;
    const auth = full?.authentication ?? {};
    const result = name => plainText(auth[name]).trim().toLowerCase();
    const dmarc = result('dmarc');
    if (dmarc)
        return dmarc === 'pass';
    const domain = address.slice(address.lastIndexOf('@') + 1);
    return result('dkim') === 'pass' && aligned(result('dkimDomain'), domain);
}

// MailCraft commands whose errors concern the one message they were run on.
const MESSAGE_COMMANDS = ['mail.get', 'mail.junk'];

/**
 * @param {Error} error an error from checking one message
 * @returns {boolean} whether it concerns that message only, so that the next
 *   messages can still be checked
 */
function concernsMessage(error) {
    return error instanceof VerdictError ||
        (error instanceof CommandError && MESSAGE_COMMANDS.includes(error.command)) ||
        (error instanceof HttpError && error.aboutRequest);
}

function nowLocal() {
    // The same form as MailCraft's `received`: local time without zone.
    return GLib.DateTime.new_now_local().format('%Y-%m-%dT%H:%M:%S');
}

export const SpamFilter = GObject.registerClass({
    Properties: {
        'state': GObject.ParamSpec.string('state', null, null,
            GObject.ParamFlags.READABLE, FilterState.OFF),
        'last-error': GObject.ParamSpec.string('last-error', null, null,
            GObject.ParamFlags.READABLE, ''),
        'moved-today': GObject.ParamSpec.int('moved-today', null, null,
            GObject.ParamFlags.READABLE, 0, GLib.MAXINT32, 0),
    },
    Signals: {
        'log-changed': {},
    },
}, class SpamFilter extends GObject.Object {
    /**
     * @param {Gio.Settings} settings the extension's settings
     * @param {import('./store.js').Store} store log and state on disk
     */
    constructor(settings, store) {
        super();
        this._settings = settings;
        this._store = store;
        this._state = FilterState.OFF;
        this._lastError = '';
        this._movedToday = 0;
        this._attempts = new Map();
        this._timeoutId = 0;
        this._running = false;
        this._cancellable = null;
        // Raised by every _sync() and by destroy(), so a _sync() that awaited
        // something knows whether it is still the latest one.
        this._generation = 0;
        this._destroyed = false;

        this._settings.connectObject(
            'changed::enabled', () => this._sync(true),
            'changed::interval-minutes', () => this._sync(false),
            this);
        this._sync(false);
        this._countMovedToday();
    }

    get state() {
        return this._state;
    }

    get lastError() {
        return this._lastError;
    }

    get movedToday() {
        return this._movedToday;
    }

    _setState(state, error = '') {
        if (this._destroyed)
            return;
        if (this._state !== state) {
            this._state = state;
            this.notify('state');
        }
        if (this._lastError !== error) {
            this._lastError = error;
            this.notify('last-error');
        }
    }

    /** Counts today's moves from the log, so the number survives a restart. */
    async _countMovedToday() {
        let log;
        try {
            log = await this._store.readLog();
        } catch (e) {
            console.error(`MailCraft Spam AI: reading the log: ${e.message}`);
            return;
        }
        if (this._destroyed)
            return;
        const today = nowLocal().slice(0, 10);
        const moved = log.filter(entry => entry.moved && String(entry.time).startsWith(today)).length;
        if (moved !== this._movedToday) {
            this._movedToday = moved;
            this.notify('moved-today');
        }
    }

    async _sync(enabledChanged) {
        const generation = ++this._generation;
        this._stopTimer();
        if (!this._settings.get_boolean('enabled')) {
            this._cancellable?.cancel();
            this._setState(FilterState.OFF);
            return;
        }
        if (enabledChanged) {
            // Turned on: only mail arriving from now on is checked.
            try {
                await this._store.writeState({since: nowLocal(), accounts: {}});
            } catch (e) {
                if (generation === this._generation)
                    this._setState(FilterState.ERROR, e.message);
                return;
            }
            if (generation !== this._generation)
                return;
        }
        this._setState(FilterState.IDLE);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('interval-minutes') * 60, () => {
                this.checkNow();
                return GLib.SOURCE_CONTINUE;
            });
        this.checkNow();
    }

    _stopTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    /** Looks at the inboxes now, unless a check is already running. */
    async checkNow() {
        if (this._running || this._destroyed || !this._settings.get_boolean('enabled'))
            return;
        this._running = true;
        this._cancellable = new Gio.Cancellable();
        this._setState(FilterState.CHECKING, this._lastError);
        this._countMovedToday();
        try {
            await this._check(this._cancellable);
            this._setState(FilterState.IDLE);
        } catch (e) {
            if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (e instanceof ControlChannelMissingError) {
                this._setState(FilterState.NO_CONTROL, e.message);
            } else if (e instanceof CommandError && e.mailboxOpening) {
                // MailCraft has just started: try again next round.
                this._setState(FilterState.IDLE);
            } else {
                // Logged once per new error, not every round while it lasts.
                if (e.message !== this._lastError)
                    console.error(`MailCraft Spam AI: ${e.message}`);
                this._setState(FilterState.ERROR, e.message);
            }
        } finally {
            this._running = false;
            if (!this._destroyed && !this._settings.get_boolean('enabled'))
                this._setState(FilterState.OFF);
        }
    }

    async _check(cancellable) {
        const settings = this._settings;
        const mailcraft = new MailCraftClient(settings.get_int('control-port'), cancellable);
        const llm = new LlmClient({
            backend: settings.get_string('backend'),
            endpoint: settings.get_string('endpoint'),
            model: settings.get_string('model'),
        }, cancellable);
        try {
            await mailcraft.open();
            const state = await this._store.readState();
            const chosen = settings.get_value('accounts').deepUnpack();
            const {accounts} = await mailcraft.execute('account.list');
            // An account MailCraft cannot list does not hold up the others;
            // its error is shown once the others are done.
            let accountError = null;
            for (const account of accounts ?? []) {
                if (chosen.length > 0 && !chosen.includes(account.id))
                    continue;
                try {
                    await this._checkAccount(mailcraft, llm, account.id, state, cancellable);
                } catch (e) {
                    if (!(e instanceof CommandError) || e.mailboxOpening)
                        throw e;
                    accountError ??= e;
                }
            }
            if (accountError)
                throw accountError;
        } finally {
            llm.destroy();
            await mailcraft.close();
        }
    }

    async _checkAccount(mailcraft, llm, accountId, state, cancellable) {
        const key = String(accountId);
        // An account seen for the first time is checked from the moment the
        // filter was turned on.
        const entry = state.accounts[key] ??= {since: state.since ?? nowLocal(), done: []};

        const {messages} = await mailcraft.execute('mail.list',
            {folder: 'inbox', account: accountId, limit: LIST_LIMIT});
        const inInbox = new Set((messages ?? []).map(m => m.id));
        const done = new Set(entry.done);
        const fresh = (messages ?? [])
            .filter(m => typeof m.received === 'string' && m.received >= entry.since && !done.has(m.id))
            .sort((a, b) => a.received.localeCompare(b.received) || a.id - b.id);

        // Attempts of this account's messages that are no longer waiting are forgotten.
        const attemptKey = id => `${key}:${id}`;
        const waiting = new Set(fresh.map(m => attemptKey(m.id)));
        for (const k of this._attempts.keys()) {
            if (k.startsWith(`${key}:`) && !waiting.has(k))
                this._attempts.delete(k);
        }

        let lastFailure = null;
        for (const message of fresh) {
            try {
                await this._checkMessage(mailcraft, llm, accountId, message);
            } catch (e) {
                // MailCraft or the model unreachable: end this round, the
                // message stays in the inbox and is checked again next round.
                if (!concernsMessage(e))
                    throw e;
                // The same error for two messages in a row is not about the
                // messages: end the round and show it, without counting it
                // against them.
                if (lastFailure && lastFailure.error === e.message) {
                    const k = attemptKey(lastFailure.id);
                    this._attempts.set(k, Math.max(0, (this._attempts.get(k) ?? 1) - 1));
                    throw e;
                }
                lastFailure = {id: message.id, error: e.message};
                const attempts = (this._attempts.get(attemptKey(message.id)) ?? 0) + 1;
                this._attempts.set(attemptKey(message.id), attempts);
                const givenUp = attempts >= MAX_ATTEMPTS;
                await this._log(message, {error: e.message, attempt: attempts, givenUp});
                if (!givenUp)
                    continue;
            }
            // A check turned off meanwhile must not write over the new state.
            if (cancellable.is_cancelled())
                return;
            this._attempts.delete(attemptKey(message.id));
            entry.done.push(message.id);
            if (entry.done.length > DONE_LIMIT) {
                const drop = entry.done.length - DONE_LIMIT;
                let dropped = 0;
                entry.done = entry.done.filter(id => dropped >= drop || inInbox.has(id) || !++dropped);
            }
            await this._store.writeState(state);
        }
        if (!cancellable.is_cancelled())
            await this._store.writeState(state);
    }

    /**
     * @returns {Promise<string|null>} why the sender is trusted, or null
     */
    async _trustReason(mailcraft, accountId, address) {
        const settings = this._settings;
        if (!address)
            return null;
        if (matchesSkipList(address, settings.get_strv('skip-senders')))
            return 'skip-list';
        if (settings.get_boolean('skip-contacts')) {
            const {contacts} = await mailcraft.execute('people.list',
                {query: address, account: 'all'});
            if ((contacts ?? []).some(c => plainText(c.email).toLowerCase() === address))
                return 'contact';
        }
        if (settings.get_boolean('skip-sent')) {
            for (const field of ['to', 'cc']) {
                const {messages} = await mailcraft.execute('mail.list',
                    {folder: 'sent', account: accountId, query: `${field}:${address}`, limit: 5});
                for (const hit of messages ?? []) {
                    // The search may match parts of addresses: only an exact
                    // recipient counts.
                    const recipients = field === 'to' ? hit.to
                        : (await mailcraft.execute('mail.get', {id: hit.id})).cc;
                    if (addressesIn(recipients).includes(address))
                        return 'sent';
                }
            }
        }
        return null;
    }

    async _checkMessage(mailcraft, llm, accountId, message) {
        const full = await mailcraft.execute('mail.get', {id: message.id});
        const address = senderAddress(full.from ?? message.from);
        const trust = await this._trustReason(mailcraft, accountId, address);
        const verified = senderVerified(full, address);
        if (trust && verified) {
            await this._log(message, {skipped: trust});
            return;
        }

        const {prompt, truncated} = buildPrompt(full, this._settings.get_int('max-chars'));
        const verdict = await llm.judge(prompt);
        const threshold = this._settings.get_int('threshold');

        let moved = false;
        if (verdict.spamValue >= threshold) {
            const result = await mailcraft.execute('mail.junk', {ids: [message.id]});
            moved = (result?.moved ?? 0) > 0;
        }
        await this._log(message, {
            spamValue: verdict.spamValue,
            explanation: verdict.explanation,
            threshold,
            truncated,
            moved,
            // A trusted address whose sender could not be verified was checked anyway.
            ...trust ? {unverified: trust} : {},
        });
    }

    async _log(message, details) {
        await this._store.appendLog({
            time: nowLocal(),
            from: plainText(message.from),
            subject: plainText(message.subject),
            ...details,
        });
        if (this._destroyed)
            return;
        this.emit('log-changed');
        if (details.moved)
            this._countMovedToday();
    }

    destroy() {
        this._destroyed = true;
        this._generation++;
        this._stopTimer();
        this._cancellable?.cancel();
        this._settings.disconnectObject(this);
    }
});
