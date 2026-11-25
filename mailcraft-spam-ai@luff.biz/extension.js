// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Steffen Luff
//
// MailCraft Spam AI: checks new mail in MailCraft with a language model and
// moves spam from the inbox to the junk folder.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SpamFilterIndicator} from './lib/quickSettings.js';
import {SpamFilter} from './lib/spamFilter.js';
import {Store} from './lib/store.js';

export default class MailCraftSpamAiExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new Store(this.uuid);
        this._filter = new SpamFilter(this._settings, this._store);
        this._indicator = new SpamFilterIndicator(this, this._filter, this._store);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    // The extension uses the unlock-dialog session mode, so disable() is not
    // called when the screen locks: the filter keeps sorting mail while the
    // user is away, so the inbox is clean when they come back. It shows
    // nothing on the lock screen and reads no input there; the Quick Settings
    // toggle is hidden while locked.
    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._filter?.destroy();
        this._filter = null;
        this._store = null;
        this._settings = null;
    }
}
