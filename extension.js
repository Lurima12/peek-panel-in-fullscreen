// SPDX-License-Identifier: GPL-2.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {PeekController} from './lib/peekController.js';

export default class FullscreenPanelPeekExtension extends Extension {
    enable() {
        this._controller = new PeekController(this.getSettings());
        this._controller.enable();
    }

    disable() {
        this._controller?.destroy();
        this._controller = null;
    }
}
