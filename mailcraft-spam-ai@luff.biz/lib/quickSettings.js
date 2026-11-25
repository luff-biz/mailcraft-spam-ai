// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff
//
// A "Spam Filter" toggle in Quick Settings, with a menu that shows the state
// and the last messages moved to junk. No icon of its own in the top bar.
// The filter keeps running while the screen is locked; the toggle is hidden
// then, so nothing about it can be changed from the lock screen.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FilterState} from './spamFilter.js';

const ICON_NAME = 'mail-mark-junk-symbolic';
const MENU_ENTRIES = 5;
const FLATPAK_ID = 'io.github.billsecond.mailcraft';

function launchMailCraft(port) {
    // A native install first, else the Flatpak. Agents only, as the Set Up
    // button in the preferences does: a stolen key cannot act as the owner.
    const args = ['--control', String(port), '--control-agents-only'];
    const argv = GLib.find_program_in_path('mailcraft')
        ? ['mailcraft', ...args]
        : ['flatpak', 'run', FLATPAK_ID, ...args];
    try {
        // As the shell starts programs: in a systemd scope of their own.
        Util.trySpawn(argv);
    } catch (e) {
        Main.notifyError(_('Could not start MailCraft'), e.message);
    }
}

const SpamFilterToggle = GObject.registerClass(
class SpamFilterToggle extends QuickMenuToggle {
    constructor(extension, filter, store) {
        super({
            title: _('Spam Filter'),
            iconName: ICON_NAME,
            toggleMode: true,
        });
        this._extension = extension;
        this._filter = filter;
        this._store = store;
        this._settings = extension.getSettings();

        this._settings.bind('enabled', this, 'checked', Gio.SettingsBindFlags.DEFAULT);

        this.menu.setHeader(ICON_NAME, _('Spam Filter'));

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._statusItem);

        this._startItem = new PopupMenu.PopupMenuItem(_('Start MailCraft with Control Channel'));
        this._startItem.connect('activate',
            () => launchMailCraft(this._settings.get_int('control-port')));
        this.menu.addMenuItem(this._startItem);

        this._checkItem = new PopupMenu.PopupMenuItem(_('Check Now'));
        this._checkItem.connect('activate', () => this._filter.checkNow());
        this.menu.addMenuItem(this._checkItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recently Moved to Junk')));
        this._recentSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._recentSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = this.menu.addAction(_('Spam Filter Settings'),
            () => this._extension.openPreferences());
        settingsItem.visible = Main.sessionMode.allowSettings;
        this.menu._settingsActions[extension.uuid] = settingsItem;

        this._filter.connectObject(
            'notify::state', () => this._sync(),
            'notify::last-error', () => this._sync(),
            'notify::moved-today', () => this._sync(),
            'log-changed', () => this._loadRecent(),
            this);
        this._sync();
        this._loadRecent();
    }

    _sync() {
        const state = this._filter.state;
        const moved = this._filter.movedToday;

        let status;
        switch (state) {
        case FilterState.OFF:
            status = _('Off');
            break;
        case FilterState.CHECKING:
            status = _('Checking the inbox…');
            break;
        case FilterState.NO_CONTROL:
            status = _('MailCraft is not running with its control channel');
            break;
        case FilterState.ERROR:
            status = _('Error: %s').format(this._filter.lastError);
            break;
        default:
            status = ngettext('%d message moved today', '%d messages moved today', moved)
                .format(moved);
        }
        this._statusItem.label.text = status;
        this._statusItem.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._startItem.visible = state === FilterState.NO_CONTROL;
        this._checkItem.visible = state !== FilterState.OFF;

        this.subtitle = state === FilterState.OFF ? null
            : state === FilterState.NO_CONTROL || state === FilterState.ERROR
                ? _('Needs attention')
                : ngettext('%d moved today', '%d moved today', moved).format(moved);
    }

    async _loadRecent() {
        let log;
        try {
            log = await this._store.readLog();
        } catch (e) {
            console.error(`MailCraft Spam AI: reading the log: ${e.message}`);
            return;
        }
        // The toggle may have been destroyed while the log was read.
        if (this._destroyed)
            return;
        this._recentSection.removeAll();
        const moved = log.filter(entry => entry.moved).slice(0, MENU_ENTRIES);
        if (moved.length === 0) {
            this._recentSection.addMenuItem(
                new PopupMenu.PopupMenuItem(_('Nothing moved yet'), {reactive: false}));
            return;
        }
        for (const entry of moved) {
            const item = new PopupMenu.PopupMenuItem(
                `${entry.spamValue} · ${entry.subject || _('(no subject)')}`,
                {reactive: false});
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._recentSection.addMenuItem(item);
        }
    }

    destroy() {
        this._destroyed = true;
        this._filter.disconnectObject(this);
        delete this.menu._settingsActions[this._extension.uuid];
        super.destroy();
    }
});

export const SpamFilterIndicator = GObject.registerClass(
class SpamFilterIndicator extends SystemIndicator {
    constructor(extension, filter, store) {
        super();
        this.quickSettingsItems.push(new SpamFilterToggle(extension, filter, store));
        Main.sessionMode.connectObject('updated', () => this._syncLocked(), this);
        this._syncLocked();
    }

    _syncLocked() {
        for (const item of this.quickSettingsItems)
            item.visible = !Main.sessionMode.isLocked;
    }

    destroy() {
        Main.sessionMode.disconnectObject(this);
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});
