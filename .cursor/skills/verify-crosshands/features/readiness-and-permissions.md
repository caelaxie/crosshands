# Readiness and permissions

Readiness tells the agent whether this CrossHands instance is worth driving at
all: payload integrity, broker endpoint privacy, session validity, capability
coverage, and OS permission state — before any desktop mutation is allowed.

## Sub-features

- `doctor-report` combines capabilities and permissions into one readiness verdict.
- `capabilities-catalog` advertises the 14 contract operations and platform supports.
- `permissions-state` reports Accessibility and Screen Recording independently.
- `payload-gate` fail-closes when the native payload is missing, version-mismatched, or unsigned.

## How to get to it (user POV)

- Run `crosshands computer doctor --json`.
- Run `crosshands computer capabilities --json`.
- Run `crosshands computer permissions [--id accessibility|screenshots] --json`.

## Driving it with the repo-built CLI

Preconditions:

- Baseline preconditions from `features/README.md`.
- For the `payload-gate` fail-closed proof: no satisfiable signed payload
  (temporarily move `packages/platform-darwin/assets/payload.json` aside, or
  run on a version with no published payload).

- **Doctor ready.** Run `$CH doctor --json`. Exit code `0`; stdout has
  `readiness: "ready"`; `checks.capabilities.platform` is `"darwin"`;
  `checks.capabilities.operations` lists all 14 operations `true`;
  `checks.permissions.permissions` shows `accessibility` and `screenshots`
  as `granted`. The contract also allows `not_required`; the macOS helper
  reports `granted` or `denied` only. Doctor has no Jev section.
- **Capabilities.** Run `$CH capabilities --json`. Exit code `0`; the result
  names the provider (`crosshands-darwin`), its version, and the `supports`
  matrix (apps, windows, surfaces, observation, actions).
- **Permissions, all.** Run `$CH permissions --json`. Exit code `0`; both
  permission ids are reported independently.
- **Permissions, one.** Run `$CH permissions --id accessibility --json`. Exit
  code `0`; the result carries the `accessibility` state.
- **Endpoint privacy.** Run `lsof -U | grep -F "$CROSSHANDS_RUNTIME_DIR"` and
  `ls -l "$CROSSHANDS_RUNTIME_DIR"`. Exactly one broker from this repo holds
  the socket; the directory is `0700`; `*.sock`, `*.sock.lease`, and
  `control.token` are mode `0600`.
- **Fail-closed gate.** With the payload absent or ad-hoc, run
  `$CH doctor --json`. Exit code `3`; stdout is
  `{"error":{"code":"provider_unavailable",...}}`. No broker survives:
  `lsof -U | grep -F "$CROSSHANDS_RUNTIME_DIR"` prints nothing.

## Gotchas

- Every CLI command, even an invalid one, connects to the broker first; with
  no live broker the only observable is exit 3 `provider_unavailable`. Arg
  validation can only be exercised once a broker is up.
- The broker's own startup failure detail is not surfaced by the CLI (the
  detached broker's stderr is discarded); the generic "did not become ready"
  message is the expected signal. Check the payload gate before assuming worse.
- `operator_action_required` means a human must grant a permission in System
  Settings. Never click the TCC dialog; hand back to the operator.
- Doctor spawns the broker if absent. A doctor run is itself proof that
  broker auto-start works.
