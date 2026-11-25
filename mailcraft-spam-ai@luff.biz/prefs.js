// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {applySetup, readSetup, removeSetup} from './lib/flatpakSetup.js';
import {LlmClient, isLocalEndpoint} from './lib/llmClient.js';
import {MailCraftClient, plainText} from './lib/mailcraftClient.js';
import {storeApiKey, lookupApiKey} from './lib/secrets.js';
import {Store} from './lib/store.js';

const BACKENDS = ['ollama', 'openai'];
const LOW_THRESHOLD = 50;

export default class MailCraftSpamAiPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_search_enabled(true);

        window.add(this._connectionPage(window, settings));
        window.add(this._filterPage(window, settings));
        window.add(this._sendersPage(window, settings));
        window.add(this._logPage());
    }

    _connectionPage(window, settings) {
        // Toast titles are markup by default; error texts are not.
        const toast = title => window.add_toast(new Adw.Toast({title, use_markup: false}));
        const page = new Adw.PreferencesPage({
            title: _('Connection'),
            icon_name: 'network-wired-symbolic',
        });

        const mailcraft = new Adw.PreferencesGroup({
            title: _('MailCraft'),
            // Adw titles and descriptions are markup: <port> must be escaped.
            description: GLib.markup_escape_text(
                _('MailCraft must open its control channel. For the Flatpak, Set Up does this on every start; otherwise start it with: mailcraft --control <port> --control-agents-only'), -1),
        });
        const port = new Adw.SpinRow({
            title: _('Control Port'),
            adjustment: new Gtk.Adjustment({lower: 1024, upper: 65535, step_increment: 1}),
        });
        settings.bind('control-port', port, 'value', Gio.SettingsBindFlags.DEFAULT);
        mailcraft.add(port);

        // One click sets MailCraft up to open its control channel on every
        // start; nothing is changed without that click.
        const setup = new Adw.ActionRow({title: _('Open the Control Channel on Every Start')});
        const setupButton = new Gtk.Button({valign: Gtk.Align.CENTER});
        const undoButton = new Gtk.Button({
            label: _('Remove'),
            tooltip_text: _('MailCraft no longer gets the two settings, also if they were set by hand'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        setup.add_suffix(undoButton);
        setup.add_suffix(setupButton);
        mailcraft.add(setup);

        const syncSetup = async () => {
            setupButton.sensitive = undoButton.sensitive = false;
            let state;
            try {
                state = await readSetup();
            } catch (e) {
                setup.subtitle = GLib.markup_escape_text(e.message, -1);
                return;
            }
            const wanted = settings.get_int('control-port');
            undoButton.visible = state.port !== null || state.agentsOnly;
            if (!state.installed) {
                setup.subtitle = _('Only for the Flatpak of MailCraft. Otherwise start it with --control and the port.');
                setupButton.visible = false;
                return;
            }
            setupButton.visible = true;
            if (state.port === wanted && state.agentsOnly) {
                setup.subtitle = _('Set up: MailCraft opens port %d on every start, for agents only.').format(wanted);
                setupButton.label = _('Set Up');
                setupButton.css_classes = [];
                setupButton.sensitive = false;
            } else {
                setup.subtitle = state.port === null
                    ? _('Not set up. MailCraft needs a restart afterwards.')
                    : _('Set up for port %d, not %d. MailCraft needs a restart afterwards.').format(state.port, wanted);
                setupButton.label = _('Set Up');
                setupButton.css_classes = ['suggested-action'];
                setupButton.sensitive = true;
            }
            undoButton.sensitive = true;
        };
        setupButton.connect('clicked', async () => {
            try {
                await applySetup(settings.get_int('control-port'));
                toast(_('Done. Restart MailCraft to use it.'));
            } catch (e) {
                toast(_('Could not set up MailCraft: %s').format(e.message));
            }
            syncSetup();
        });
        undoButton.connect('clicked', async () => {
            try {
                await removeSetup();
            } catch (e) {
                toast(_('Could not remove the setup: %s').format(e.message));
            }
            syncSetup();
        });
        settings.connect('changed::control-port', () => syncSetup());
        syncSetup();

        page.add(mailcraft);

        const model = new Adw.PreferencesGroup({title: _('Language Model')});
        const syncPrivacy = () => {
            const address = settings.get_string('endpoint');
            model.description = isLocalEndpoint(address)
                ? _('Mail is only sent to the endpoint entered here, which is on this computer.')
                : address.toLowerCase().startsWith('http://')
                    ? _('Warning: this endpoint is not on this computer and the connection is not encrypted. The text of every checked mail is sent there.')
                    : _('This endpoint is not on this computer: the text of every checked mail is sent there.');
        };

        const backend = new Adw.ComboRow({
            title: _('Kind of Endpoint'),
            model: Gtk.StringList.new([_('Ollama'), _('OpenAI-compatible')]),
            selected: Math.max(0, BACKENDS.indexOf(settings.get_string('backend'))),
        });
        backend.connect('notify::selected',
            () => settings.set_string('backend', BACKENDS[backend.selected]));
        model.add(backend);

        const endpoint = new Adw.EntryRow({
            title: _('Address'),
            show_apply_button: true,
            text: settings.get_string('endpoint'),
        });
        endpoint.connect('apply', () => settings.set_string('endpoint', endpoint.text.trim()));
        model.add(endpoint);

        const apiKey = new Adw.PasswordEntryRow({
            title: _('API Key (kept in the keyring)'),
            show_apply_button: true,
        });
        apiKey.connect('apply', async () => {
            // The key belongs to the address shown above, even if it was not applied yet.
            if (endpoint.text.trim() !== settings.get_string('endpoint'))
                settings.set_string('endpoint', endpoint.text.trim());
            try {
                await storeApiKey(settings.get_string('endpoint'), apiKey.text,
                    _('MailCraft Spam AI API key'));
                apiKey.text = '';
                toast(_('API key saved'));
            } catch (e) {
                toast(_('Could not save the API key: %s').format(e.message));
            }
        });
        model.add(apiKey);

        const syncApiKey = async () => {
            const isOpenAi = settings.get_string('backend') === 'openai';
            apiKey.visible = isOpenAi;
            if (!isOpenAi)
                return;
            try {
                const stored = await lookupApiKey(settings.get_string('endpoint'));
                apiKey.title = stored ? _('API Key (saved; enter a new one to replace it)')
                    : _('API Key (kept in the keyring)');
            } catch {
                apiKey.title = _('API Key (keyring not available)');
            }
        };

        // A combo row always shows one item and cannot show "nothing chosen",
        // so "No model chosen" is an item of its own, first in the list. What
        // the row shows is always what is saved. A saved model the endpoint
        // does not offer stays as an item of its own instead of being replaced.
        const models = Gtk.StringList.new([]);
        let values = [];
        const modelRow = new Adw.ComboRow({
            title: _('Model'),
            model: models,
        });
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Load the models of the endpoint'),
            css_classes: ['flat'],
        });
        modelRow.add_suffix(refresh);
        model.add(modelRow);

        let loading = false;
        const fillModels = names => {
            const saved = settings.get_string('model');
            const missing = saved !== '' && !names.includes(saved);
            values = ['', ...missing ? [saved] : [], ...names];
            loading = true;
            models.splice(0, models.get_n_items(), [
                _('No model chosen'),
                ...missing ? [_('%s (not offered by the endpoint)').format(saved)] : [],
                ...names,
            ]);
            modelRow.selected = values.indexOf(saved);
            loading = false;
        };
        let modelsRequest = 0;
        const loadModels = async () => {
            // Only the latest request fills the list.
            const request = ++modelsRequest;
            const client = new LlmClient({
                backend: settings.get_string('backend'),
                endpoint: settings.get_string('endpoint'),
                model: '',
            }, null);
            try {
                const names = await client.listModels();
                if (request !== modelsRequest)
                    return;
                fillModels(names);
                modelRow.subtitle = names.length ? '' : _('The endpoint offers no models');
            } catch (e) {
                if (request !== modelsRequest)
                    return;
                fillModels([]);
                modelRow.subtitle = GLib.markup_escape_text(
                    _('Endpoint not reachable: %s').format(e.message), -1);
            } finally {
                client.destroy();
            }
        };
        modelRow.connect('notify::selected', () => {
            if (loading || modelRow.selected === Gtk.INVALID_LIST_POSITION)
                return;
            settings.set_string('model', values[modelRow.selected]);
        });
        refresh.connect('clicked', () => loadModels());

        for (const key of ['backend', 'endpoint']) {
            settings.connect(`changed::${key}`, () => {
                syncApiKey();
                syncPrivacy();
                loadModels();
            });
        }
        syncApiKey();
        syncPrivacy();
        loadModels();

        page.add(model);
        return page;
    }

    _filterPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Filter'),
            icon_name: 'mail-mark-junk-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: _('Spam Filter')});
        const threshold = new Adw.SpinRow({
            title: _('Spam Threshold'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5}),
        });
        settings.bind('threshold', threshold, 'value', Gio.SettingsBindFlags.DEFAULT);
        const syncThreshold = () => {
            const value = settings.get_int('threshold');
            threshold.subtitle = value === 0
                ? _('Every message will be moved to junk!')
                : value < LOW_THRESHOLD
                    ? _('Very low: many good messages may be moved to junk.')
                    : _('Messages rated at or above this value (0–100) are moved to junk.');
        };
        settings.connect('changed::threshold', syncThreshold);
        syncThreshold();
        group.add(threshold);

        const interval = new Adw.SpinRow({
            title: _('Check Every (Minutes)'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 120, step_increment: 1}),
        });
        settings.bind('interval-minutes', interval, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(interval);

        const maxChars = new Adw.SpinRow({
            title: _('Longest Mail Text (Characters)'),
            subtitle: _('Longer mail is shortened before it is sent to the model.'),
            adjustment: new Gtk.Adjustment({lower: 500, upper: 100000, step_increment: 500}),
        });
        settings.bind('max-chars', maxChars, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(maxChars);
        page.add(group);

        const accounts = new Adw.PreferencesGroup({
            title: _('Accounts'),
            description: _('With none chosen, every account is filtered.'),
        });
        const reload = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Load the accounts from MailCraft'),
            css_classes: ['flat'],
        });
        accounts.set_header_suffix(reload);
        const rows = [];
        const loadAccounts = async () => {
            rows.splice(0).forEach(row => accounts.remove(row));
            const client = new MailCraftClient(settings.get_int('control-port'), null);
            try {
                await client.open();
                const result = await client.execute('account.list');
                const chosen = new Set(settings.get_value('accounts').deepUnpack());
                for (const account of result.accounts ?? []) {
                    const row = new Adw.SwitchRow({
                        title: GLib.markup_escape_text(plainText(account.email), -1),
                        active: chosen.has(account.id),
                    });
                    row.connect('notify::active', () => {
                        const ids = new Set(settings.get_value('accounts').deepUnpack());
                        if (row.active)
                            ids.add(account.id);
                        else
                            ids.delete(account.id);
                        settings.set_value('accounts', new GLib.Variant('ai', [...ids]));
                    });
                    accounts.add(row);
                    rows.push(row);
                }
            } catch (e) {
                const row = new Adw.ActionRow({
                    title: _('MailCraft not reachable'),
                    subtitle: GLib.markup_escape_text(e.message, -1),
                });
                accounts.add(row);
                rows.push(row);
            } finally {
                await client.close();
            }
        };
        reload.connect('clicked', () => loadAccounts());
        loadAccounts();
        page.add(accounts);
        return page;
    }

    _sendersPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Trusted Senders'),
            icon_name: 'avatar-default-symbolic',
        });

        const sources = new Adw.PreferencesGroup({
            title: _('Never Check Mail From'),
        });
        const sent = new Adw.SwitchRow({
            title: _('People You Have Written To'),
            subtitle: _('Looked up in the Sent folder of the account.'),
        });
        settings.bind('skip-sent', sent, 'active', Gio.SettingsBindFlags.DEFAULT);
        sources.add(sent);
        const contacts = new Adw.SwitchRow({
            title: _('Your MailCraft Contacts'),
        });
        settings.bind('skip-contacts', contacts, 'active', Gio.SettingsBindFlags.DEFAULT);
        sources.add(contacts);
        page.add(sources);

        const list = new Adw.PreferencesGroup({
            title: _('Skip List'),
            description: _('A full address (user@example.org) or a whole domain (@example.org).'),
        });
        const add = new Adw.EntryRow({
            title: _('Add Address or Domain'),
            show_apply_button: true,
        });
        list.add(add);
        const rows = [];
        const render = () => {
            rows.splice(0).forEach(row => list.remove(row));
            for (const entry of settings.get_strv('skip-senders')) {
                const row = new Adw.ActionRow({title: GLib.markup_escape_text(entry, -1)});
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Remove'),
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => settings.set_strv('skip-senders',
                    settings.get_strv('skip-senders').filter(e => e !== entry)));
                row.add_suffix(remove);
                list.add(row);
                rows.push(row);
            }
        };
        add.connect('apply', () => {
            const entry = add.text.trim().toLowerCase();
            if (!/^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(entry))
                return;
            const current = settings.get_strv('skip-senders');
            if (!current.includes(entry))
                settings.set_strv('skip-senders', [...current, entry]);
            add.text = '';
        });
        settings.connect('changed::skip-senders', render);
        render();
        page.add(list);
        return page;
    }

    _logPage() {
        const page = new Adw.PreferencesPage({
            title: _('Log'),
            icon_name: 'document-open-recent-symbolic',
        });
        const store = new Store(this.uuid);
        const group = new Adw.PreferencesGroup({
            title: _('Last Checks'),
            description: _('The last 100 checks. Kept only on this computer.'),
        });
        const clear = new Gtk.Button({
            label: _('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        group.set_header_suffix(clear);
        const rows = [];
        const describe = entry => {
            if (entry.error) {
                return entry.givenUp
                    ? _('Error, given up and left in the inbox: %s').format(entry.error)
                    : _('Error, will try again: %s').format(entry.error);
            }
            if (entry.skipped)
                return _('Trusted sender, not checked');
            const verdict = entry.moved ? _('moved to junk') : _('left in the inbox');
            const text = `${entry.spamValue}/100 · ${verdict} · ${entry.explanation}`;
            return entry.unverified
                ? `${text}\n${_('Trusted address, but the sender could not be verified, so it was checked.')}`
                : text;
        };
        const load = async () => {
            rows.splice(0).forEach(row => group.remove(row));
            const log = await store.readLog();
            if (log.length === 0) {
                const row = new Adw.ActionRow({title: _('Nothing checked yet')});
                group.add(row);
                rows.push(row);
                return;
            }
            for (const entry of log) {
                const row = new Adw.ActionRow({
                    title: GLib.markup_escape_text(entry.subject || _('(no subject)'), -1),
                    subtitle: GLib.markup_escape_text(
                        `${entry.time.replace('T', ' ')} · ${entry.from}\n${describe(entry)}`, -1),
                    subtitle_lines: 4,
                });
                group.add(row);
                rows.push(row);
            }
        };
        clear.connect('clicked', async () => {
            await store.clearLog();
            await load();
        });
        page.connect('map', () => load());
        page.add(group);
        return page;
    }
}
