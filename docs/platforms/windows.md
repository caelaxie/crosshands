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
level, Authenticode publisher, and SHA-256. It also verifies foreground
activation before synthetic pointer or keyboard input. UI Automation patterns
are preferred to synthetic input. Password-like fields are redacted in the
native provider before data is serialized.

## Process and transport hardening

The packaged `runtime.ps1` is resolved relative to the installed provider. It is
started with an absolute Windows PowerShell 5.1 path, `-NoProfile`,
`-NonInteractive`, disabled module autoloading, and a minimized environment.
Operation envelopes—including typed or pasted text—travel only over the child
process stdin. They are never command-line arguments or temporary operation
files. A timed-out or disconnected mutation is not replayed automatically.

The broker's Windows named-pipe endpoint requires a native backend that creates
an explicit current-logon-SID DACL and verifies a local client's PID, SID, logon
session, and integrity while impersonating it. The TypeScript package exposes
this backend boundary but intentionally fails closed when no native backend is
installed; Node's named-pipe API alone is not treated as proof of those
properties.

## Verification status

Static TypeScript and source-characterization tests run on every development
platform. A release claim additionally requires real clean Windows 10/11 x64
runners to execute:

- the native parser check in `native/windows/tests/verify-runtime.ps1` using
  Windows PowerShell 5.1;
- UI Automation fixture tests for discovery, duplicate names, multiple windows,
  pattern actions, redaction, and bounded trees;
- Unicode/IME, modifier cleanup, clipboard restoration, multi-monitor and
  mixed-DPI fixture tests;
- lock/UAC/elevation/session/RDP transition tests and PID/publisher/hash swap
  tests;
- installation from a path containing spaces, package hash and Authenticode
  verification, and the repeated 95% conformance matrix.

Passing static tests on macOS or Linux is not Windows runtime evidence.
