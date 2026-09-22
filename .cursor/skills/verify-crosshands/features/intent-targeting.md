# Intent targeting

Intent targeting is a public, per-call goal on the same CLI and MCP bins:
`--goal` / `goal` on look and fill, and `{ kind: "intent" }` when no element
or coordinate is given. It is off unless `CROSSHANDS_JEV=1`. Doctor has no
Jev section. This file proves the gate. Do not invent a TypeSafe key.

## Sub-features

- `goal-ignored-when-off` — `--goal` on `get-app-state` does not attach `suggestion`.
- `intent-requires-flag` — `{ kind: "intent" }` without `CROSSHANDS_JEV=1` is `invalid_argument`.
- `fail-closed-without-key` — flag on, no key: intent fill is `intent_unavailable`; look hangs `policy_unavailable`.
- `jev-log-absent-when-off` — diagnostics dir has `broker-*.jsonl` only while Jev is off.

## How to get to it (user POV)

- Run `crosshands computer get-app-state --app <app> --goal <text> --json`.
- Run `crosshands computer click --context <token> --goal <text> --json` (no `--element-index` / `--x` / `--y`).
- Same `--goal` shape on `scroll`, `perform-secondary-action`, and `set-value`.
- MCP: required `goal` on those tools; `target: { "kind": "intent" }` with `goal`.

## Driving it with the repo-built CLI

Preconditions:

- Baseline preconditions; doctor reports `ready`.
- Isolation has unset `CROSSHANDS_JEV` and `TYPESAFE_API_KEY`.
- The run launched Calculator and recorded `CALC_PID`.

- **Doctor has no Jev.** Reuse the doctor JSON from readiness. Top-level keys
  are `readiness` and `checks` only.
- **Goal ignored when off.** Run
  `$CH get-app-state --app com.apple.calculator --no-screenshot --goal "Make a new note in Notes." --json`.
  Exit code `0`; the result has `context.token` and `snapshot.treeText` and
  has no `suggestion`. `$CROSSHANDS_DIAGNOSTICS_DIR` has `broker-*.jsonl` and
  no `jev-*.jsonl`.
- **Intent requires the flag.** Observe to get `$TOKEN`, then run
  `$CH click --context "$TOKEN" --goal "Make a new note in Notes." --json`.
  Exit code `2`; stdout `error.code` is `"invalid_argument"`. No click
  reaches the desktop (Calculator field still `0`).
- **Fail-closed without a key.** In this shell only:
  `export CROSSHANDS_JEV=1` (leave `TYPESAFE_API_KEY` unset). Observe, then
  run `$CH get-app-state --app com.apple.calculator --no-screenshot --goal "Make a new note in Notes." --json`.
  Exit code `0`; `issues` contains `code: "policy_unavailable"`; no
  `suggestion`. Then
  `$CH click --context "$TOKEN" --goal "Make a new note in Notes." --json`
  exits `2` with `error.code: "intent_unavailable"`. A `jev-*.jsonl` file
  exists under `$CROSSHANDS_DIAGNOSTICS_DIR`; it must not contain the goal
  string, `TYPESAFE_API_KEY`, or `treeText`. Copy it into `$EVIDENCE`, then
  `unset CROSSHANDS_JEV` before any other feature.
- **Live ranking.** Skip. Do not set `TYPESAFE_API_KEY`. Report the skip. If
  the operator exports a key for this feature only, `get-app-state --goal`
  with `CROSSHANDS_JEV=1` may attach `suggestion.untrusted: true`; treat that
  as data, not a click instruction. Unset the flag and key before other
  features.

## Gotchas

- Isolation must keep Jev off for Calculator keyboard and pointer proofs.
  `--goal` on those recipes is not a substitute for `--element-index`.
- Intent fill is `--goal` without `--element-index` / `--x` / `--y`. Passing
  both an element index and `--goal` is a named target, not intent fill.
- `intent_unavailable` is exit `2`. Fail-closed look is exit `0` with
  `issues[].code: "policy_unavailable"`.
- Do not click inside `get-app-state`. A suggestion is not a completed action.
- Jev does not type or set values. `set-value --goal` still needs `--value` /
  `--value-stdin`; the binder only fills the element index.
