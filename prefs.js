// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const POSITION_VALUES = ['auto', 'top', 'bottom'];

export default class FullscreenPanelPeekPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const _ = this.gettext.bind(this);
        const settings = this.getSettings();

        // Keep the Gio.Settings object alive for the lifetime of the window.
        window._settings = settings;
        window.connect('close-request', () => {
            window._settings = null;
        });

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // --- Panel position -------------------------------------------------
        const positionGroup = new Adw.PreferencesGroup({
            title: _('Panel'),
            description: _('Automatic detection follows the panel if another extension moves it.'),
        });
        page.add(positionGroup);

        const positionRow = new Adw.ComboRow({
            title: _('Panel position'),
            model: new Gtk.StringList({
                strings: [_('Automatic'), _('Top'), _('Bottom')],
            }),
        });
        positionRow.selected = Math.max(
            0, POSITION_VALUES.indexOf(settings.get_string('position-mode')));
        positionRow.connect('notify::selected', () => {
            settings.set_string('position-mode', POSITION_VALUES[positionRow.selected]);
        });
        positionGroup.add(positionRow);

        // --- Reveal behaviour -----------------------------------------------
        const peekGroup = new Adw.PreferencesGroup({title: _('Peeking')});
        page.add(peekGroup);

        this._addSpinRow(peekGroup, settings, 'trigger-size',
            _('Trigger thickness'), _('Edge strip height in pixels'), 1, 16, 1);
        this._addSpinRow(peekGroup, settings, 'show-delay',
            _('Reveal delay'), _('Milliseconds the pointer rests on the edge'), 0, 2000, 50);
        this._addSpinRow(peekGroup, settings, 'hide-delay',
            _('Hide delay'), _('Milliseconds after the pointer leaves the panel'), 0, 5000, 50);

        // --- Animation ------------------------------------------------------
        const animationGroup = new Adw.PreferencesGroup({title: _('Animation')});
        page.add(animationGroup);

        this._addSpinRow(animationGroup, settings, 'animation-time',
            _('Slide duration'), _('Milliseconds; 0 disables the animation'), 0, 1000, 10);

        // --- Games ----------------------------------------------------------
        const gamesGroup = new Adw.PreferencesGroup({
            title: _('Games'),
            description: _('For excluded fullscreen windows the panel behaves like stock GNOME: hidden, with no peeking.'),
        });
        page.add(gamesGroup);

        const gameModeRow = new Adw.SwitchRow({
            title: _('Disable while GameMode is active'),
            subtitle: _('Only games started through Feral GameMode are detected'),
        });
        settings.bind('exclude-gamemode', gameModeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        gamesGroup.add(gameModeRow);

        const appsRow = new Adw.EntryRow({
            title: _('Excluded apps (window class or app ID, * allowed, comma separated)'),
        });
        appsRow.text = settings.get_strv('exclude-apps').join(', ');
        appsRow.connect('changed', () => {
            settings.set_strv('exclude-apps', appsRow.text
                .split(',')
                .map(item => item.trim())
                .filter(item => item.length > 0));
        });
        gamesGroup.add(appsRow);
    }

    _addSpinRow(group, settings, key, title, subtitle, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                page_increment: step * 5,
            }),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(row);
    }
}
