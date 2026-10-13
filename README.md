# Peek Panel in Fullscreen

Hides the GNOME Shell panel while a window is fullscreen on the panel's monitor,
and lets you peek at it again:

- push the pointer against the screen edge where the panel lives, or
- press `Super+Shift+P` to pin it open (press again to hide).

The panel stays open while one of its menus is open and while the pointer is on it.
It is always visible in the Overview.

## Games

The extension steps aside for games: while Feral GameMode has a registered game, or
when the fullscreen window's class or app ID matches `exclude-apps` (default
`steam_app_*`, which Steam sets for games; Steam Big Picture is not matched), the
panel behaves like stock GNOME. To find a window's class, run `xprop WM_CLASS` and click
it, or open Looking Glass (`Alt+F2`, `lg`) and use the Windows tab.

## Layout

```
fullscreen-panel-peek@lurim412/
├── metadata.json
├── extension.js              enable()/disable() only
├── prefs.js                  Adwaita preferences (no Shell imports)
├── lib/
│   ├── panelLocator.js       finds the panel's monitor and top/bottom edge
│   └── peekController.js     fullscreen tracking, trigger strip, animation
└── schemas/
    └── org.gnome.shell.extensions.fullscreen-panel-peek.gschema.xml
```

## Installation

```sh
git clone peek-panel-in-fullscreen peek-panel-in-fullscreen@lurim412
cp -r peek-panel-in-fullscreen@lurim412 ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/fullscreen-panel-peek@lurim412/schemas
```

Log out and back in (Wayland), then:

```sh
gnome-extensions enable fullscreen-panel-peek@lurim412
```

To iterate without logging out, use a nested session:

```sh
# GNOME 49 and newer
dbus-run-session gnome-shell --devkit --wayland
# GNOME 46-48
dbus-run-session gnome-shell --nested --wayland
```

Watch logs with `journalctl -f -o cat /usr/bin/gnome-shell`.

## Package

```sh
cd fullscreen-panel-peek@lurim412
gnome-extensions pack --force --extra-source=lib
```

## Shortcut

The shortcut is a GSettings key, editable with:

```sh
gsettings --schemadir schemas set org.gnome.shell.extensions.fullscreen-panel-peek toggle-peek "['<Super><Shift>p']"
```

## Notes

- Blur My Shell: only the whole `panelBox` is hidden, translated and faded. The panel,
  its children and anything Blur My Shell attaches to the box are left alone, so the
  blur slides with the panel.
- Panel position is read from the panelBox's real geometry, so it follows extensions
  that move the panel to the bottom. Extensions that replace the panel with their own
  actors (such as Dash to Panel) are not supported.
- Do not run alongside other extensions that hide the panel in fullscreen
  (Hide Top Bar, Just Perfection's panel options), they will fight over visibility.
- `Main.layoutManager._trackedActors` is private shell API. A fallback guard is
  included if it changes, but check it after major GNOME releases.
