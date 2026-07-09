# Linux support

CrossHands v1 targets **Ubuntu 24.04 x64, GNOME on Xorg** for its blocking Linux
conformance score. The provider runs in the current unlocked graphical session;
headless shells, a lock screen, another user's session, and system services are
reported as unavailable.

## Required system packages

CrossHands detects these dependencies but never installs them:

```sh
sudo apt install python3 python3-gi at-spi2-core gir1.2-atspi-2.0 \
  gir1.2-gtk-3.0 xdotool xclip dbus-user-session
```

`xsel` may replace `xclip`. The active desktop must provide `XDG_RUNTIME_DIR`,
`DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, and `XDG_SESSION_TYPE=x11`. Run the
CrossHands doctor/smoke test from a terminal launched inside that desktop
session after installation.

Readiness diagnostics name missing components individually: Python/PyGObject,
AT-SPI, GDK/GdkPixbuf, the accessibility session bus, display, clipboard tool,
and X11 utilities. CrossHands does not modify the desktop accessibility setting
or start a session bus on the operator's behalf.

## X11 and Wayland capability boundary

On the declared X11 target, the provider supports app/window discovery,
bounded AT-SPI snapshots, window screenshots, semantic actions, pointer input,
keyboard input, hotkeys, scrolling, dragging, value setting, and clipboard
paste when their dependencies are ready.

Wayland starts in capability-reduced mode. AT-SPI discovery and semantic
actions may remain available, and `wl-clipboard` may provide clipboard access,
but v1 does **not** advertise or attempt X11 screenshot, coordinate-pointer,
synthetic-keyboard, hotkey, scroll, or drag paths. XDG desktop-portal automation
is deferred. An unsupported request returns `unsupported_capability`; it never
simulates success.

## Process boundary and safety

The broker launches an absolute, hash-verified packaged `runtime.py` using an
absolute Python 3 path with `-I -u`, `/` as its working directory, and a minimal
environment. Caller `PYTHONPATH`, `PYTHONHOME`, executable search paths, loader
injection variables, and shell profiles are not inherited. Requests and literal
input use framed stdin/stdout only—never command arguments or operation files.

The provider resolves X11 and clipboard tools to absolute paths from the fixed
system path before use. It bounds accessibility traversal and screenshots,
redacts secure fields before serialization, blocks known secrets applications,
and rechecks process start/executable identity for action targets. A stale PID,
changed executable, window/element mismatch, session transition, or provider
restart requires a fresh observation.

On X11, a native screenshot capture or PNG encoding failure is preserved in
the observation `issues` array. It is not collapsed into an unexplained
`screenshot: null` result.

## Release-runner evidence

Static, standard-library protocol, hash, and degradation tests run on every
development host. Release evidence still requires a real Ubuntu 24.04 GNOME
Xorg runner for fixture-app discovery, Unicode/truncation, multiple windows,
coordinates, screenshot bounds, semantic and synthetic actions, stale-state
recovery, lock/unlock transitions, and the repeated 90% conformance threshold.
A GNOME Wayland runner separately verifies that no X11-only operation is
dispatched.
