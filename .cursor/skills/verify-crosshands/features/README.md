# CrossHands verification map

This directory is the maintained source for verifying the user-facing behavior
of CrossHands. The "user" is an agent or operator driving the repo-built JSON
CLI or the MCP adapter. Read this index before driving, then use the matching
feature file as the recipe.

## Baseline preconditions

- The repo is built: `pnpm install --frozen-lockfile && pnpm build`.
- The macOS payload gate is satisfied (signed payload in
  `packages/platform-darwin/assets/` whose `productVersion` equals
  `CONTRACT_VERSIONS.product`), or the run explicitly targets the fail-closed tier.
- `CROSSHANDS_RUNTIME_DIR` and `CROSSHANDS_DIAGNOSTICS_DIR` point at a fresh
  scratch dir owned by this run; `EVIDENCE` points at a fresh
  `.crosshands/verify/<run-id>/`. `CROSSHANDS_JEV` and `TYPESAFE_API_KEY` are
  unset (SKILL isolation) except while driving `intent-targeting.md`.
- `node packages/cli/dist/bin.js computer doctor --json` exits 0 and reports
  `readiness: "ready"` (or the run documents the reduced/fail-closed tier).
- `lsof -U | grep -F "$CROSSHANDS_RUNTIME_DIR"` shows exactly one broker, from
  this repo's `packages/cli/dist/bin.js`.
- Never drive an instance this run did not start; never drive apps the run did
  not launch (the map uses Calculator only).

## Driving conventions

- `CH` means `node packages/cli/dist/bin.js computer`. Always pass `--json`.
- Save every response to `$EVIDENCE`. Name files after the step.
- Token extraction works for both response shapes:
  `s.context?.token ?? s.freshState?.context?.token`.
- "Read the edit field" on Calculator means: in `snapshot.treeText`, find the
  line containing `scroll area Edit field`, then take the first following
  `text` line, strip leading element index and U+200E marks.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Restore app state after a mutation (clear the Calculator field with Escape,
  quit apps the run launched). Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Observation proof includes the JSON and, for screenshots, the exported PNG
  plus its `sha256` from the result.
- Mutation proof includes the mutation response (`outcome`) and a fresh
  observation showing the resulting state. `indeterminate` is not success.
- Contract proof (errors, exit codes) records the exact `error.code`,
  `remediation`, and exit code.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet
  precondition. Do not report a skipped entry point as verified through a
  different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the
user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled
   bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable
handles, required state, commands, and observable proof.

## Features

- [Readiness and permissions](./readiness-and-permissions.md) covers doctor,
  capabilities, permissions, and the fail-closed payload integrity gate.
- [Desktop observation](./desktop-observation.md) covers listing apps and
  windows, reading app state, and exporting screenshots.
- [Keyboard input](./keyboard-input.md) covers typing, keys, hotkeys, paste,
  set-value, and protected stdin input, with the canonical Calculator proof.
- [Pointer actions](./pointer-actions.md) covers element and coordinate
  clicks, secondary actions, scroll, and drag.
- [MCP adapter](./mcp-adapter.md) covers the stdio server, tool catalog
  parity, and protected-input rejection.
- [Intent targeting](./intent-targeting.md) covers per-call `--goal` / `goal`
  and `{ kind: "intent" }` targets. Off unless `CROSSHANDS_JEV=1`; skip live
  ranking when `TYPESAFE_API_KEY` is absent.
