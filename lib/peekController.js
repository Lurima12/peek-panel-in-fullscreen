// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {locatePanel, PanelPosition} from './panelLocator.js';

const LOG_PREFIX = '[fullscreen-panel-peek]';
const POLL_INTERVAL_MS = 100;
const EDGE_POLL_INTERVAL_MS = 50;
const POINTER_MARGIN_PX = 2;
const EXIT_DEBOUNCE_MS = 120;

const GAMEMODE_NAME = 'com.feralinteractive.GameMode';
const GAMEMODE_PATH = '/com/feralinteractive/GameMode';

// Simple case-insensitive glob: '*' matches any run of characters.
function globMatch(pattern, text) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`, 'i').test(text);
}

/**
 * Hides Main.layoutManager.panelBox while the panel's monitor has a
 * fullscreen window, and reveals it on demand.
 *
 * Blur My Shell compatibility: only the panelBox as a whole is hidden,
 * translated and faded. Main.panel, its children, its style classes and
 * any actors/effects other extensions attach to the panelBox are never
 * touched, so the blur travels with the panel.
 */
export class PeekController {
    constructor(settings) {
        this._settings = settings;
        this._signals = [];

        this._panelBox = null;
        this._edge = null;
        this._armed = false;
        this._pointerInEdge = false;
        this._exitTimeoutId = 0;
        this._edgePollId = 0;
        this._unredirectDisabled = false;
        this._warnedNoUnredirect = false;

        this._excluded = false;
        this._gameMode = null;
        this._cancellable = null;

        this._fullscreen = false;
        this._inOverview = false;
        this._peeking = false;
        this._manualPeek = false;
        this._panelHidden = false;
        this._outsideMs = 0;

        this._showTimeoutId = 0;
        this._pollId = 0;

        this._trackData = null;
        this._origTrackFullscreen = true;
    }

    // ---------------------------------------------------------------- setup

    enable() {
        this._panelBox = Main.layoutManager.panelBox;

        this._takeOverFullscreenTracking();
        this._forceShown();
        this._connectSignals();
        this._addKeybinding();

        this._fullscreen = this._queryFullscreen();
        this._inOverview = Main.overview.visible;
        this._refreshExclusion();
        this._connectGameMode();
        this._sync(false);
    }

    destroy() {
        this._cancelShowTimeout();
        this._cancelExitTimeout();
        this._stopPolling();
        this._stopEdgePolling();
        this._cancellable?.cancel();
        this._cancellable = null;
        this._gameMode = null;

        Main.wm.removeKeybinding('toggle-peek');

        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];

        this._enableUnredirect();
        this._clearTransitions();
        this._panelBox.translation_y = 0;
        this._panelBox.opacity = 255;

        // Hand fullscreen handling back to the shell.
        if (this._trackData)
            this._trackData.trackFullscreen = this._origTrackFullscreen;
        this._trackData = null;

        const hide = this._queryFullscreen() && !Main.overview.visible &&
            Main.sessionMode.hasWindows;
        this._panelBox.visible = !hide;
        Main.layoutManager._updateFullscreen?.();

        this._panelBox = null;
        this._settings = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _connectSignals() {
        this._connect(global.display, 'in-fullscreen-changed',
            () => this._onGeometryChanged());
        this._connect(Main.layoutManager, 'monitors-changed',
            () => this._onGeometryChanged());
        for (const prop of ['x', 'y', 'width', 'height']) {
            this._connect(this._panelBox, `notify::${prop}`,
                () => this._onGeometryChanged());
        }
        this._connect(Main.overview, 'showing', () => {
            this._inOverview = true;
            this._resetPeekState();
            // No slide here: the shell reserves layout space for the panel
            // from its on-screen position at the moment it measures, so an
            // animated panel would leave the search bar underneath it.
            this._sync(false);
            Main.layoutManager._queueUpdateRegions?.();
        });
        this._connect(Main.overview, 'hiding', () => {
            this._inOverview = false;
            this._sync(true);
        });
        this._connect(Main.sessionMode, 'updated', () => this._sync(false));
        this._connect(global.display, 'notify::focus-window',
            () => this._onGeometryChanged());
        this._connect(this._settings, 'changed', () => this._onGeometryChanged());
    }

    _addKeybinding() {
        Main.wm.addKeybinding(
            'toggle-peek',
            this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._togglePeek());
    }

    /**
     * The shell's Chrome hides trackFullscreen actors itself. We want to own
     * the panel box's visibility in fullscreen, so switch tracking off for it.
     * _trackedActors is private shell API; if it ever disappears we fall back
     * to correcting the box's visibility whenever the shell changes it.
     */
    _takeOverFullscreenTracking() {
        const tracked = Main.layoutManager._trackedActors;
        this._trackData = tracked?.find(d => d.actor === this._panelBox) ?? null;

        if (this._trackData) {
            this._origTrackFullscreen = this._trackData.trackFullscreen;
            this._trackData.trackFullscreen = false;
        } else {
            console.warn(`${LOG_PREFIX} panelBox is not a tracked chrome actor`);
        }

        // Belt and braces: whatever the shell does, keep the panel box in the
        // state this extension wants while a fullscreen window is active.
        this._connect(this._panelBox, 'notify::visible',
            () => this._guardVisibility());
    }

    _guardVisibility() {
        if (!this._fullscreen || this._inOverview || !Main.sessionMode.hasWindows)
            return;
        // visible while we want it hidden, or hidden while we want it shown
        if (this._panelBox.visible === this._panelHidden) {
            this._log('shell changed panel visibility, restoring');
            this._panelBox.visible = !this._panelHidden;
        }
    }

    // ------------------------------------------------------------ edge watch

    // The pointer position is sampled while the panel is hidden. No actor is
    // placed on the screen edge, so the focused app never sees a pointer
    // leave/enter just because the pointer touched the edge.

    _updateEdge() {
        const loc = this._locate();
        if (!loc) {
            this._edge = null;
            return;
        }
        const size = this._settings.get_int('trigger-size');
        const {monitor, position} = loc;
        this._edge = {
            x1: monitor.x,
            x2: monitor.x + monitor.width,
            y1: position === PanelPosition.TOP
                ? monitor.y
                : monitor.y + monitor.height - size,
            y2: position === PanelPosition.TOP
                ? monitor.y + size
                : monitor.y + monitor.height,
        };
    }

    _inEdge(x, y) {
        const e = this._edge;
        return !!e && x >= e.x1 && x < e.x2 && y >= e.y1 && y < e.y2;
    }

    _startEdgePolling() {
        if (this._edgePollId)
            return;
        // Require the pointer to leave and re-enter the edge before the next
        // reveal, so it does not instantly re-peek after being dismissed.
        const [x, y] = global.get_pointer();
        this._pointerInEdge = this._inEdge(x, y);
        this._edgePollId = this._addTimeout(EDGE_POLL_INTERVAL_MS, 'edge',
            () => this._pollEdge());
    }

    _stopEdgePolling() {
        if (this._edgePollId) {
            GLib.Source.remove(this._edgePollId);
            this._edgePollId = 0;
        }
        this._pointerInEdge = false;
    }

    _pollEdge() {
        if (!this._armed) {
            this._edgePollId = 0;
            return GLib.SOURCE_REMOVE;
        }

        const [x, y] = global.get_pointer();
        const inside = this._inEdge(x, y);
        if (inside && !this._pointerInEdge) {
            this._pointerInEdge = true;
            this._log('pointer entered edge');
            this._onEdgeEnter();
        } else if (!inside && this._pointerInEdge) {
            this._pointerInEdge = false;
            this._cancelShowTimeout();
        }
        return GLib.SOURCE_CONTINUE;
    }

    _onEdgeEnter() {
        this._cancelShowTimeout();
        const delay = this._settings.get_int('show-delay');
        if (delay === 0) {
            this._startPeek(false);
            return;
        }
        this._showTimeoutId = this._addTimeout(delay, 'show', () => {
            this._showTimeoutId = 0;
            this._startPeek(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ----------------------------------------------------------- peek state

    _startPeek(manual) {
        if (!this._fullscreen || this._inOverview || this._excluded)
            return;
        this._log(`peek start (manual=${manual})`);
        this._peeking = true;
        this._manualPeek = manual;
        this._outsideMs = 0;
        this._sync(true);
        this._startPolling();
    }

    _endPeek(animate) {
        this._log('peek end');
        this._resetPeekState();
        this._sync(animate);
    }

    _resetPeekState() {
        this._peeking = false;
        this._manualPeek = false;
        this._outsideMs = 0;
        this._cancelShowTimeout();
        this._stopPolling();
    }

    _togglePeek() {
        if (!this._fullscreen || this._inOverview || this._excluded)
            return;
        if (this._peeking && this._manualPeek)
            this._endPeek(true);
        else
            this._startPeek(true);
    }

    _startPolling() {
        if (this._pollId)
            return;
        this._pollId = this._addTimeout(POLL_INTERVAL_MS, 'poll', () => this._poll());
    }

    _stopPolling() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }
    }

    _poll() {
        if (!this._peeking) {
            this._pollId = 0;
            return GLib.SOURCE_REMOVE;
        }

        if (this._manualPeek || this._menuOpen() || this._pointerOverPanel()) {
            this._outsideMs = 0;
            return GLib.SOURCE_CONTINUE;
        }

        this._outsideMs += POLL_INTERVAL_MS;
        if (this._outsideMs >= this._settings.get_int('hide-delay')) {
            this._pollId = 0;
            this._endPeek(true);
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _menuOpen() {
        return !!Main.panel.menuManager?.activeMenu;
    }

    _pointerOverPanel() {
        const [x, y] = global.get_pointer();
        const box = this._panelBox;
        const m = POINTER_MARGIN_PX;
        return x >= box.x - m && x < box.x + box.width + m &&
               y >= box.y - m && y < box.y + box.height + m;
    }

    // ------------------------------------------------------ panel show/hide

    _locate() {
        return locatePanel(this._settings.get_string('position-mode'));
    }

    _queryFullscreen() {
        const loc = this._locate();
        return loc ? global.display.get_monitor_in_fullscreen(loc.monitorIndex) : false;
    }

    _onGeometryChanged() {
        this._updateEdge();
        const exclusionChanged = this._refreshExclusion();

        const fullscreen = this._queryFullscreen();
        if (fullscreen === this._fullscreen) {
            this._cancelExitTimeout();
            if (exclusionChanged) {
                this._resetPeekState();
                this._sync(true);
                return;
            }
            // Panel moved (e.g. another extension put it at the bottom): keep
            // the hidden offset pointing the right way.
            if (this._panelHidden)
                this._panelBox.translation_y = this._hiddenOffset();
            return;
        }

        if (fullscreen) {
            this._cancelExitTimeout();
            this._setFullscreen(true);
            return;
        }

        // Leaving fullscreen: wait briefly so a momentary flip while an app
        // rearranges its windows cannot cancel a peek.
        if (this._exitTimeoutId)
            return;
        this._exitTimeoutId = this._addTimeout(EXIT_DEBOUNCE_MS, 'exit', () => {
            this._exitTimeoutId = 0;
            if (!this._queryFullscreen())
                this._setFullscreen(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setFullscreen(fullscreen) {
        this._log(`fullscreen=${fullscreen}`);
        this._fullscreen = fullscreen;
        this._resetPeekState();
        this._sync(true);
    }

    _sync(animate) {
        const shouldHide = this._fullscreen && !this._inOverview &&
            !this._peeking && Main.sessionMode.hasWindows;

        this._updateEdge();
        const armed = shouldHide && !this._excluded;
        if (armed !== this._armed)
            this._log(`armed=${armed}`);
        this._armed = armed;
        if (armed)
            this._startEdgePolling();
        else
            this._stopEdgePolling();

        if (shouldHide) {
            this._hidePanel(animate);
        } else {
            // While the panel is on screen over a fullscreen window, the
            // compositor must keep compositing. Windows that are scanned out
            // directly would otherwise cover shell UI, leaving the panel
            // clickable but invisible.
            if (this._fullscreen && !this._inOverview)
                this._disableUnredirect();
            else
                this._enableUnredirect();
            this._showPanel(animate);
        }
    }

    // ------------------------------------------------------------ exclusions

    _connectGameMode() {
        this._cancellable = new Gio.Cancellable();
        // DO_NOT_AUTO_START: never launch gamemoded just to ask it a question.
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null,
            GAMEMODE_NAME,
            GAMEMODE_PATH,
            GAMEMODE_NAME,
            this._cancellable,
            (_source, result) => {
                try {
                    this._gameMode = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._log(`GameMode proxy unavailable: ${e.message}`);
                    return;
                }
                this._connect(this._gameMode, 'g-properties-changed',
                    () => this._onGeometryChanged());
                this._connect(this._gameMode, 'notify::g-name-owner',
                    () => this._onGeometryChanged());
                this._onGeometryChanged();
            });
    }

    _gameModeActive() {
        if (!this._gameMode || !this._settings.get_boolean('exclude-gamemode'))
            return false;
        if (!this._gameMode.g_name_owner)
            return false;
        const count = this._gameMode.get_cached_property('ClientCount');
        return !!count && count.deepUnpack() > 0;
    }

    _fullscreenWindow() {
        const loc = this._locate();
        if (!loc)
            return null;
        const actors = global.get_window_actors();  // bottom to top
        for (let i = actors.length - 1; i >= 0; i--) {
            const win = actors[i].meta_window;
            if (win && win.is_fullscreen() && !win.minimized &&
                win.get_monitor() === loc.monitorIndex)
                return win;
        }
        return null;
    }

    _excludedByApp() {
        const patterns = this._settings.get_strv('exclude-apps');
        if (patterns.length === 0)
            return false;
        const win = this._fullscreenWindow();
        if (!win)
            return false;
        const ids = [
            win.get_wm_class(),
            win.get_wm_class_instance(),
            win.get_gtk_application_id(),
        ].filter(Boolean);
        return patterns.some(pattern => ids.some(id => globMatch(pattern, id)));
    }

    /** @returns {boolean} whether the exclusion state changed */
    _refreshExclusion() {
        const excluded = this._gameModeActive() || this._excludedByApp();
        if (excluded === this._excluded)
            return false;
        this._log(`excluded=${excluded}`);
        this._excluded = excluded;
        return true;
    }

    /**
     * Newer mutter exposes this on the compositor object; older versions use
     * Meta.*_unredirect_for_display(). Returns {disable, enable} or null.
     */
    _unredirectApi() {
        const compositor = global.compositor;
        if (typeof compositor?.disable_unredirect === 'function' &&
            typeof compositor?.enable_unredirect === 'function') {
            return {
                disable: () => compositor.disable_unredirect(),
                enable: () => compositor.enable_unredirect(),
            };
        }
        if (typeof Meta.disable_unredirect_for_display === 'function' &&
            typeof Meta.enable_unredirect_for_display === 'function') {
            return {
                disable: () => Meta.disable_unredirect_for_display(global.display),
                enable: () => Meta.enable_unredirect_for_display(global.display),
            };
        }
        return null;
    }

    _disableUnredirect() {
        if (this._unredirectDisabled)
            return;
        const api = this._unredirectApi();
        if (!api) {
            if (!this._warnedNoUnredirect) {
                this._warnedNoUnredirect = true;
                console.warn(`${LOG_PREFIX} no unredirect API found on this shell`);
            }
            return;
        }
        api.disable();
        this._unredirectDisabled = true;
        this._log('unredirect disabled');
    }

    _enableUnredirect() {
        if (!this._unredirectDisabled)
            return;
        this._unredirectApi()?.enable();
        this._unredirectDisabled = false;
        this._log('unredirect enabled');
    }

    _hiddenOffset() {
        const loc = this._locate();
        const height = this._panelBox.height;
        return loc?.position === PanelPosition.BOTTOM ? height : -height;
    }

    _duration() {
        if (!St.Settings.get().enable_animations)
            return 0;
        return this._settings.get_int('animation-time');
    }

    _clearTransitions() {
        this._panelBox.remove_transition('translation-y');
        this._panelBox.remove_transition('opacity');
    }

    _hidePanel(animate) {
        if (this._panelHidden)
            return;
        this._panelHidden = true;
        this._clearTransitions();

        const duration = animate ? this._duration() : 0;
        if (duration === 0) {
            this._applyHidden();
            return;
        }

        this._panelBox.ease({
            translation_y: this._hiddenOffset(),
            opacity: 0,
            duration,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._panelHidden)
                    this._applyHidden();
            },
        });
    }

    _applyHidden() {
        this._panelBox.translation_y = this._hiddenOffset();
        this._panelBox.opacity = 0;
        this._panelBox.hide();
        this._enableUnredirect();
    }

    _showPanel(animate) {
        if (!this._panelHidden)
            return;
        this._panelHidden = false;
        this._clearTransitions();
        this._panelBox.show();

        const duration = animate ? this._duration() : 0;
        if (duration === 0) {
            this._panelBox.translation_y = 0;
            this._panelBox.opacity = 255;
            return;
        }

        this._panelBox.ease({
            translation_y: 0,
            opacity: 255,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _forceShown() {
        this._panelHidden = false;
        this._clearTransitions();
        this._panelBox.translation_y = 0;
        this._panelBox.opacity = 255;
        this._panelBox.show();
    }

    // ------------------------------------------------------------ utilities

    _addTimeout(ms, name, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, callback);
        GLib.Source.set_name_by_id(id, `${LOG_PREFIX} ${name}`);
        return id;
    }

    _cancelExitTimeout() {
        if (this._exitTimeoutId) {
            GLib.Source.remove(this._exitTimeoutId);
            this._exitTimeoutId = 0;
        }
    }

    _log(message) {
        if (this._settings?.get_boolean('debug'))
            console.log(`${LOG_PREFIX} ${message}`);
    }

    _cancelShowTimeout() {
        if (this._showTimeoutId) {
            GLib.Source.remove(this._showTimeoutId);
            this._showTimeoutId = 0;
        }
    }
}
