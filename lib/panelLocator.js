// SPDX-License-Identifier: GPL-2.0-or-later

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const PanelPosition = Object.freeze({
    TOP: 'top',
    BOTTOM: 'bottom',
});

/**
 * Locate the panel box on screen.
 *
 * Uses the panel box's *allocation* (x, y, width, height), never its
 * transformed extents, so the result stays correct while this extension
 * has the box translated off-screen.
 *
 * @param {string} mode - 'auto', 'top' or 'bottom'
 * @returns {{monitorIndex: number, monitor: object, position: string}|null}
 */
export function locatePanel(mode = 'auto') {
    const {monitors, primaryIndex, panelBox} = Main.layoutManager;
    if (!monitors || monitors.length === 0)
        return null;

    const cx = panelBox.x + panelBox.width / 2;
    const cy = panelBox.y + panelBox.height / 2;

    let monitorIndex = monitors.findIndex(m =>
        cx >= m.x && cx < m.x + m.width &&
        cy >= m.y && cy < m.y + m.height);
    if (monitorIndex < 0)
        monitorIndex = primaryIndex;

    const monitor = monitors[monitorIndex];
    if (!monitor)
        return null;

    let position;
    if (mode === PanelPosition.TOP || mode === PanelPosition.BOTTOM)
        position = mode;
    else
        position = cy < monitor.y + monitor.height / 2
            ? PanelPosition.TOP
            : PanelPosition.BOTTOM;

    return {monitorIndex, monitor, position};
}
