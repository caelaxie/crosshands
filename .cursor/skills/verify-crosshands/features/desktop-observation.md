# Desktop observation

Observation lets the agent see the real desktop: which apps run, which windows
they own, the accessibility tree of a window, and a screenshot — the read side
of the observe-act-verify loop.

## Sub-features

- `list-apps` enumerates running apps with stable ids, pids, and bundle ids.
- `list-windows` enumerates one app's windows with ids, indexes, titles, and bounds.
- `get-app-state` captures the accessibility tree, a context token, and an optional screenshot.
- `screenshot-export` writes a new mode-0600 PNG with a recorded sha256.

## How to get to it (user POV)

- Run `crosshands computer list-apps --json`.
- Run `crosshands computer list-windows --app <app> --json`.
- Run `crosshands computer get-app-state --app <app> [--window-id <id> | --window-index <n>] [--no-screenshot] [--screenshot-output <new-path>] --goal <goal> --json`.

## Driving it with the repo-built CLI

Preconditions:

- Baseline preconditions; doctor reports `ready`.
- The run launched Calculator (`open -a Calculator`) and recorded its pid from
  the `list-apps` result as `CALC_PID`.

- **List apps.** Run `$CH list-apps --json`. Exit code `0`; the `apps` array
  contains an entry with `id`/`bundleId` `com.apple.calculator`, `name`
  `Calculator`, the recorded `pid`, and `isRunning: true`.
- **List windows.** Run `$CH list-windows --app com.apple.calculator --json`.
  Exit code `0`; `windows[0]` has a numeric-string `id`, `index` 0, title
  `Calculator`, and logical `bounds`.
- **Read state.** Run `$CH get-app-state --app com.apple.calculator --goal "Read the Calculator window." --json`.
  Exit code `0`; the result has `context.token` (`ctx_…`), a `snapshot` with
  `treeText` (root line `App=com.apple.calculator (pid <pid>)`), `elementCount`, and a
  base64 `screenshot` with `scale`. `issues` is `[]`.
- **Export screenshot.** Run
  `$CH get-app-state --app com.apple.calculator --goal "Read the Calculator window." --screenshot-output "$EVIDENCE/state.png" --json`.
  Exit code `0`; the file exists with mode `0600`; the result's `screenshot`
  carries `path`, `bytes`, `sha256`, and `dataOmitted: true`. Re-running with
  the same output path exits `2` (`invalid_argument`, overwrite refused).
- **No-screenshot read.** Run
  `$CH get-app-state --app com.apple.calculator --no-screenshot --goal "Read the Calculator window." --json`. Exit
  code `0`; `screenshot` is `null` and `issues` is `[]`.
- **Window selector.** Run
  `$CH get-app-state --app com.apple.calculator --window-index 0 --no-screenshot --goal "Read the Calculator window." --json`.
  Exit code `0`; same window as the unselected read.
- **Proof.** `$EVIDENCE` holds the list-apps, list-windows, and state JSON
  plus `state.png`; the PNG visually matches the `treeText` content.

## Gotchas

- A Calculator window that has just opened can make `get-app-state` exit `4`
  with `permission_denied` ("visible windows but no accessibility window")
  even while doctor says `ready`. Wait a couple of seconds and observe again
  before treating that as a missing Accessibility grant.
- Element indexes in `treeText` belong to the returned context token and go
  stale after any mutation, rerender, or window change. Always re-observe.
- Calculator's `treeText` shows buttons without names; identify digit buttons
  by position or drive the keyboard instead (see `keyboard-input.md`).
- After Calculator gains history, the tree grows a `Last Expression` scroll
  area and all later indexes shift. Never reuse indexes across observations.
- `screenshot: null` is not proof of capture failure by itself; inspect the
  `issues` array for an actionable screenshot error.
- Observation errors surface with their contract code:
  `$CH get-app-state --app <missing> --goal "Read the window." --json` and
  `list-windows --app <missing>` exit `1` with `error.code: "app_not_found"`,
  `retry: true`, `remediation: "refresh_apps"`. (Found 2026-09-21 by this
  skill as a bug — the broker masked provider-originated observation errors as
  `request_failed` with a schema-validation message — and fixed the same day
  in `packages/runtime/src/broker/broker.ts`; regression coverage:
  `tests/broker/runtime.test.ts` "surfaces provider observation errors with
  their contract code".)
