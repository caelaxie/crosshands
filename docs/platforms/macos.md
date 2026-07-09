# macOS provider

CrossHands supports macOS 14 and later on Apple silicon and Intel. The provider is a Swift 6 helper named **CrossHands Computer Use** with bundle identifier `ai.crosshands.ComputerUse`. The JavaScript payload launches it from the package-relative path `assets/CrossHands Computer Use.app`; it does not use Electron paths or the caller's working directory.

## Build and signing

Build a universal helper app with:

```sh
native/macos/scripts/build-universal-app.sh
```

The script builds `arm64` and `x86_64` release slices, verifies both with `lipo`, assembles the app bundle, and verifies its signature. Local builds use ad-hoc signing. Release candidates must set `CROSSHANDS_CODESIGN_IDENTITY` to the project's stable Developer ID identity before the immutable candidate is created; notarization is a release-pipeline responsibility.

## Permissions

Accessibility and Screen Recording are separate permissions. `crosshands permissions --json` reports each state independently. The helper never clicks or accepts a TCC dialog and never calls the programmatic Screen Recording request API. The optional permission guide only opens the corresponding System Settings pane; the operator grants access manually to **CrossHands Computer Use**.

Accessibility is required for snapshots and actions. Screen Recording is required only when a screenshot is requested. ScreenCaptureKit is the sole screenshot path on macOS 14+, including mixed-scale window capture.

## Local security boundary

The broker starts one helper for the active graphical session. Communication uses a mode-`0600` Unix-domain socket, a random token stored in a mode-`0600` file, and a same-effective-user peer check. No TCP listener exists. Tokens and text inputs are sent in the socket payload rather than process arguments.

The helper rejects known password-manager bundle identifiers before observation or action. Secure accessibility fields are changed to `[redacted]` before the snapshot is serialized. Every target carries process launch time, executable identity, owner PID, window ID, snapshot ID, provider generation, and graphical-session evidence; the broker and helper revalidate this state before dispatch.

## Operational behavior

- The helper exposes applications, windows, bounded accessibility snapshots, and window screenshots.
- Actions include semantic and coordinate clicks, secondary accessibility actions, scrolling, dragging, literal typing, keys, hotkeys, exact paste, and value setting.
- Window or element changes produce an explicit stale/missing-target error. A provider restart changes its generation and invalidates old references.
- Minimized or unavailable windows are not silently treated as successful targets.
- Screenshot permission, lookup, timeout, and capture failures are returned explicitly in the observation `issues` array; accessibility-only observation remains available with `screenshot: null`, and callers can retry with screenshots disabled.

The provider only controls the local, unlocked Aqua session. Remote machines, background login sessions, privilege elevation, and automated permission grants are outside the first release.
