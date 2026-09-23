# Pointer actions

Pointer actions let the agent click elements or coordinates, invoke an
element's accessibility actions, scroll, and drag inside a target window.
Element targets use the accessibility press path; coordinate targets upgrade
to the accessibility action of the element at the point when one exists
(synthetic fallback) and must always be re-verified.

## Sub-features

- `click-element` presses an element by index (AX action path).
- `click-coordinate` synthetic-clicks a window-local point.
- `secondary-action` performs an action the element has, including names the tree omits from `Secondary Actions`.
- `scroll` scrolls a window or element in a direction.
- `drag` drags between two elements or two points.

## How to get to it (user POV)

- Run `crosshands computer click --context <token> (--element-index <n> | --x <x> --y <y>) --goal <goal> [--mouse-button left|right|middle] [--modifiers Shift+CmdOrCtrl] --json`.
- Run `crosshands computer perform-secondary-action --context <token> --element-index <n> --action <name> --goal <goal> --json`.
- Run `crosshands computer scroll --context <token> (--element-index <n> | --x <x> --y <y>) --direction <up|down|left|right> [--pages <n>] --goal <goal> --json`.
- Run `crosshands computer drag --context <token>` with both ends as element indexes (`--from-element-index` and `--to-element-index`) or both ends as points (`--from-x`, `--from-y`, `--to-x`, `--to-y`). Optional `--duration-ms`. A mixed pair is not a drag.

## Driving it with the repo-built CLI

Preconditions:

- Baseline preconditions; doctor reports `ready`.
- The run launched Calculator and recorded `CALC_PID`; the edit field reads `0`.

- **Element click, named target.** Observe, find the toolbar button whose
  name matches `Sidebar` in `treeText` (it reads `Show Sidebar` when closed,
  `Hide Sidebar` when open), then run
  `$CH click --context "$TOKEN" --element-index <n> --goal "Press the control." --json`. Exit code `0`. A
  fresh observation shows the sidebar opened: `elementCount` rises (30 → 57
  observed) and window `bounds.width` grows (230 → 458 observed). Click the
  same button again (now named `Hide Sidebar`) to restore.
- **Element click, digit.** With the sidebar closed and the field at `0`,
  observe, compute the digit-`1` button index: buttons follow the edit field's
  `text` element in row-major order starting at `AC`, so `1` is
  (edit-text index) + 13 — verified as index 16 in the fresh 30-element tree
  and 43 in the 57-element sidebar tree; always recompute from the fresh
  tree. Run `$CH click --context "$TOKEN" --element-index <n> --goal "Press the control." --json`. A fresh
  observation reads the edit field as `1`. Restore with `Escape`.
- **Coordinate click, verified.** Observe with
  `--screenshot-output "$EVIDENCE/before-click.png"`, pick the target's pixel
  center in the PNG, divide by `screenshot.scale`, then run
  `$CH click --context "$TOKEN" --x <x> --y <y> --goal "Press the control." --json`. Re-observe and assert
  the intended state change. Measure carefully: the PNG starts at the
  window's top-left but the title bar, toolbar, and display area consume the
  top of the basic Calculator window. A mis-measured point can hit another
  button. Re-observe. Do not treat a `0` exit as proof, and do not retry an
  unchanged display blindly.
- **Secondary action refusal.** Observe, pick an element advertising
  `Secondary Actions` (the `scroll area Edit field` always does), then run
  `$CH perform-secondary-action --context "$TOKEN" --element-index <n> --action delete --goal "Press the control." --json`.
  Exit code `0` with `outcome.state: "not_attempted"` and
  `outcome.error.code: "action_not_supported"`. The refusal is the proof.
  Names on the `Secondary Actions` line work. Raw names the tree omits,
  including `AXPress`, work too.
- **Scroll and drag.** Calculator's basic mode has no deterministic
  scrollable or draggable surface. Verify these only against an
  operator-authorized app with such a surface, using the exact command shapes
  above, and prove by a fresh observation (scrolled content, moved element).

## Gotchas

- Prefer element targets. A plain coordinate click with no modifiers and a
  click count of 1 uses the accessibility action of the element at that
  point when the element's process is the target. The synthetic
  `postToPid` path remains for points with no actionable element, for
  modified clicks, and for a click count above 1. Re-observe. Exit `0` is
  not proof of effect.
- Element indexes shift when the tree changes (opening Calculator's history
  sidebar renumbers everything). Compute indexes from the same observation
  whose token you pass.
- Non-empty `--modifiers` on click skips the AX press path and forces the
  synthetic path — expect the weaker verification story.
- Middle-click is rejected on the synthetic path (`invalid_argument`). An
  element middle-click with no modifiers still tries `AXPress` first.
  Right-click element targets try `AXShowMenu`.
- `perform-secondary-action` matches action names case-insensitively against
  every action on the element, including names omitted from the
  `Secondary Actions` line. Anything else is `action_not_supported`,
  returned as `outcome.state: "not_attempted"` with exit code `0`.
- A drag whose ends are not both elements or both points exits `0` with
  `outcome.state: "not_attempted"` and `outcome.error.code: "invalid_argument"`.
  It does not move the pointer.
