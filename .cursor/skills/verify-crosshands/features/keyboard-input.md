# Keyboard input

Keyboard input lets the agent type literal text, press named keys, send
hotkeys, paste exact text, and set element values into the focused window —
with a secret-safe stdin channel for protected text. This file holds the
canonical live proof for CrossHands: driving Calculator to evaluate `9*9`.

## Sub-features

- `type-text` types literal characters into the context window.
- `press-key` presses a named key (`Return`, `Escape`, `=`, arrows, ...).
- `hotkey` sends a modifier chord (`CmdOrCtrl+Shift+P`).
- `paste-text` writes into a focused field that accepts replacement, and does not touch the clipboard on that path. Otherwise it saves the clipboard, pastes, and restores it.
- `set-value` writes an element's AX value when the element is settable.
- `protected-stdin` reads `--text-stdin` / `--value-stdin` from stdin only.

## How to get to it (user POV)

- Run `crosshands computer type-text --context <token> --text <text> --json`.
- Run `crosshands computer press-key --context <token> --key <key> --json`.
- Run `crosshands computer hotkey --context <token> --key CmdOrCtrl+Shift+P --json`.
- Run `crosshands computer paste-text --context <token> --text <text> --json`.
- Run `crosshands computer set-value --context <token> --element-index <n> --value <value> --goal <goal> --json`.
- Run `printf '%s' "$SECRET" | crosshands computer type-text --context <token> --text-stdin --json`.

## Driving it with the repo-built CLI

Preconditions:

- Baseline preconditions; doctor reports `ready`.
- The run launched Calculator and recorded `CALC_PID`.
- "Read the edit field" follows the convention in `features/README.md`.

- **Clear.** Observe, then run
  `$CH press-key --context "$TOKEN" --key Escape --json`. A fresh observation
  reads the edit field as `0`.
- **Type.** Observe, then run
  `$CH type-text --context "$TOKEN" --text "9*9" --json`. Exit code `0`;
  `outcome.state` is `indeterminate` with reason `synthetic_input` (delivery
  is not success). A fresh observation reads the edit field as `9×9`.
- **Evaluate.** Observe, then run
  `$CH press-key --context "$TOKEN" --key "=" --json`. Wait ~1s, then run
  `$CH get-app-state --app com.apple.calculator --goal "Read the Calculator window." --screenshot-output "$EVIDENCE/calc-proof.png" --json`.
  The edit field reads `81`; the `Last Expression` area reads `9×9`; the PNG
  shows both. This is the canonical proof.
- **Protected stdin.** Run
  `printf '%s' "42" | $CH type-text --context "$TOKEN" --text-stdin --json`.
  Exit code `0`; stderr is empty and the canary is not a CLI argument. The
  field shows the typed digits, so that text also appears in the result
  snapshot.
- **Set-value refusal.** Observe, find the edit field's `text` element index,
  then run `$CH set-value --context "$TOKEN" --element-index <n> --value "123" --goal "Set the field." --json`.
  Exit code `0` with `outcome.state: "not_attempted"` and
  `outcome.error.code: "value_not_settable"` — Calculator's display is
  read-only, and the refusal is the proof.
- **Restore.** Press `Escape` so the field returns to `0`; quit Calculator by
  `CALC_PID` during cleanup.

## Gotchas

- Mutations return the fresh context at `freshState.context.token`, not
  top-level `context.token`. Extract from both shapes.
- `=` and `Return` both evaluate in Calculator, and on a result they repeat
  the last operation (`15` then `=` yields `15+8` pending). Evaluate exactly
  once, then re-observe.
- Key delivery is asynchronous. If an observation right after a keypress
  shows the pre-key state, wait ~1s and observe again before concluding.
- The key name set is finite (`native/macos/.../KeyChord.swift`): letters,
  digits, `=`, `-`, arrows, `Return`/`Enter`, `Escape`/`Esc`, `Tab`, `Space`,
  `Backspace`/`Delete`, etc. `*` and `multiply` are accepted and sent as
  Shift-8. An unknown name such as `f1` exits `0` with
  `outcome.state: "not_attempted"` and `outcome.error.code: "invalid_argument"`.
  Exit `2` is only a CLI-local rejection, such as a missing flag.
- `hotkey` requires at least one modifier plus a key. `paste-text` touches
  the clipboard only when the focused field does not accept replacement.
  Prefer `type-text` in proofs and never use paste for secrets.
- `type-text`/`set-value` accept `--text`/`--value` literals, but protected
  values must go over stdin; the CLI never falls back across channels.
