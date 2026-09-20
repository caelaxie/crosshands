# Pointer actions

Pointer actions let the agent click elements or coordinates, invoke advertised
accessibility secondary actions, scroll, and drag inside a target window.
Element targets use the accessibility press path; coordinate targets upgrade
to the accessibility action of the element at the point when one exists
(synthetic fallback) and must always be re-verified.

## Sub-features

- `click-element` presses an element by index (AX action path).
- `click-coordinate` synthetic-clicks a window-local point.
- `secondary-action` performs an element's advertised AX secondary action.
- `scroll` scrolls a window or element in a direction.
- `drag` drags between two elements or two points.

## How to get to it (user POV)

- Run `crosshands computer click --context <token> (--element-index <n> | --x <x> --y <y>) [--mouse-button left|right|middle] [--modifiers Shift+CmdOrCtrl] --json`.
- Run `crosshands computer perform-secondary-action --context <token> --element-index <n> --action <name> --json`.
- Run `crosshands computer scroll --context <token> (--element-index <n> | --x <x> --y <y>) --direction <up|down|left|right> [--pages <n>] --json`.
- Run `crosshands computer drag --context <token> (--from-element-index <n> | --from-x <x> --from-y <y>) (--to-element-index <n> | --to-x <x> --to-y <y>) [--duration-ms <n>] --json`.

## Driving it with the repo-built CLI

Preconditions:

- Baseline preconditions; doctor reports `ready`.
- The run launched Calculator and recorded `CALC_PID`; the edit field reads `0`.

- **Element click, named target.** Observe, find the toolbar button whose
  name matches `Sidebar` in `treeText` (it reads `Show Sidebar` when closed,
  `Hide Sidebar` when open), then run
  `$CH click --context "$TOKEN" --element-index <n> --json`. Exit code `0`. A
  fresh observation shows the sidebar opened: `elementCount` rises (30 → 57
  observed) and window `bounds.width` grows (230 → 458 observed). Click the
  same button again (now named `Hide Sidebar`) to restore.
- **Element click, digit.** With the sidebar closed and the field at `0`,
  observe, compute the digit-`1` button index: buttons follow the edit field's
  `text` element in row-major order starting at `AC`, so `1` is
  (edit-text index) + 13 — verified as index 16 in the fresh 30-element tree
  and 43 in the 57-element sidebar tree; always recompute from the fresh
  tree. Run `$CH click --context "$TOKEN" --element-index <n> --json`. A fresh
  observation reads the edit field as `1`. Restore with `Escape`.
- **Coordinate click, verified.** Observe with
  `--screenshot-output "$EVIDENCE/before-click.png"`, pick the target's pixel
  center in the PNG, divide by `screenshot.scale`, then run
  `$CH click --context "$TOKEN" --x <x> --y <y> --json`. Re-observe and assert
  the intended state change. Measure carefully: the PNG starts at the
  window's top-left but the title bar, toolbar, and display area consume the
  top ~60% of the basic Calculator window — on 2026-09-21 a mis-measured
  point landed on `Change Sign` instead of `1`, which looks exactly like a
  dropped click on a `0` field. If nothing changed at a well-measured point,
  that is the expected staged-payload behavior (see Gotchas) — record it; do
  not retry blindly.
- **Secondary action refusal.** Observe, pick an element advertising
  `Secondary Actions` (the `scroll area Edit field` always does), then run
  `$CH perform-secondary-action --context "$TOKEN" --element-index <n> --action delete --json`.
  Exit code `0` with `outcome.state: "not_attempted"` and
  `outcome.error.code: "action_not_supported"` — the refusal with remediation
  is the proof; the valid action names are the ones advertised in the
  element's `Secondary Actions` list.
- **Scroll and drag.** Calculator's basic mode has no deterministic
  scrollable or draggable surface. Verify these only against an
  operator-authorized app with such a surface, using the exact command shapes
  above, and prove by a fresh observation (scrolled content, moved element).

## Gotchas

- Prefer element targets. Coordinate clicks post synthetic mouse events to
  the target pid (`CGEvent.postToPid`), and SwiftUI apps such as Calculator
  silently drop queue-injected mouse events — the click dispatches but nothing
  changes. Root-caused 2026-09-21: at the same point, HID-tap events and an AX
  hit-test + `AXPress` both work, while `postToPid` does not; the HID tap is
  deliberately off-limits (pinned by `ProviderBoundarySourceTests`), so in
  source, plain coordinate clicks now upgrade to the accessibility action of
  the element at the point (same action preference as element clicks,
  pid-checked, synthetic fallback when nothing actionable sits there). The fix
  ships with the next native payload release; staged payloads ≤ 0.1.6 still
  drop synthetic coordinate clicks. A `0` exit code and even
  `dispatched: true` in diagnostics are not proof of effect — re-observe.
- Element indexes shift when the tree changes (opening Calculator's history
  sidebar renumbers everything). Compute indexes from the same observation
  whose token you pass.
- Non-empty `--modifiers` on click skips the AX press path and forces the
  synthetic path — expect the weaker verification story.
- Middle-click is rejected (`invalid_argument`); right-click element targets
  try `AXShowMenu`.
- `perform-secondary-action` matches action names case-insensitively against
  the element's advertised actions; anything else is `action_not_supported`,
  returned as `outcome.state: "not_attempted"` with exit code `0`.
