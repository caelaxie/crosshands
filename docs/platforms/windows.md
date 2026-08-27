# Windows provider

CrossHands v1 targets Windows 10 22H2 and current GA Windows 11 on x64, in the
current user's active, unlocked, local interactive desktop. The provider uses
Windows PowerShell 5.1, .NET UI Automation, and Win32 input/capture APIs.
PowerShell 7 (`pwsh`) is not required.

## Supported boundary

The provider supports equal-integrity desktop applications. It does not support
elevated targets, UIAccess, the UAC secure desktop, services/session 0, another
user's session, locked desktops, or RDP/remote control. Those states return an
explicit non-success result; CrossHands does not silently fall back across the
boundary.

Before a mutation, CrossHands re-resolves the target and compares PID, process
start time, logon session, input desktop, absolute executable path, integrity
level, optional Authenticode publisher of the target executable, and SHA-256.
It also verifies foreground activation before synthetic pointer or keyboard
input. UI Automation patterns
are preferred to synthetic input. Password-like fields are redacted in the
native provider before data is serialized.

## Process and transport hardening

The packaged `runtime.ps1` is resolved relative to the installed provider. It is
started with an absolute Windows PowerShell 5.1 path, `-NoProfile`,
`-NonInteractive`, disabled module autoloading, and a minimized environment.
Operation envelopes—including typed or pasted text—travel only over the child
process stdin. They are never command-line arguments or temporary operation
files. A timed-out or disconnected mutation is not replayed automatically.

The broker's Windows named-pipe endpoint is owned by the packaged
`crosshands-pipe-relay.exe` helper rather than Node. The helper creates an
explicit current-logon-SID DACL, rejects remote pipe clients, and verifies a
local client's PID, user SID, logon SID/authentication ID, Windows session,
process start time, executable path, and integrity level while impersonating
the client. Only after those checks does it relay framed bytes to the broker.
The JavaScript host verifies the helper's package hash before launch and still
requires the versioned control handshake before parsing a request. The Windows
payload is unsigned. A missing, substituted, or unbuildable relay fails closed;
Node's named-pipe API alone is not treated as proof. Windows may show an
Unknown publisher or SmartScreen warning for the helper.

## Verification status

Target-window capture failures are returned in the observation `issues` array
with `screenshot_failed` remediation. CrossHands never falls back to sampling
the desktop when `PrintWindow` cannot capture the selected HWND.

Static TypeScript and source-characterization tests run on every development
platform. A release claim additionally requires real clean Windows 10/11 x64
runners to execute:

- the native parser check in `native/windows/tests/verify-runtime.ps1` using
  Windows PowerShell 5.1;
- the x64 relay build plus DACL, local-only, SID/logon-session, equal-integrity,
  process-identity, handshake-before-dispatch, and payload-hash tests;
- UI Automation fixture tests for discovery, duplicate names, multiple windows,
  pattern actions, redaction, and bounded trees;
- Unicode/IME, modifier cleanup, clipboard restoration, multi-monitor and
  mixed-DPI fixture tests;
- lock/UAC/elevation/session/RDP transition tests and PID/publisher/hash swap
  tests;
- installation from a path containing spaces, package hash verification, and
  the repeated 95% conformance matrix.

Passing static tests on macOS or Linux is not Windows runtime evidence.
