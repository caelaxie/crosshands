# Type in TextEdit, then use Calculator

Time limit 180 seconds. Follow the rules in [the suite readme](README.md).

## Goal

This is the only text the agent sees.

```text
note.txt is open in TextEdit and it is empty. Calculator is open and shows 0.
Save this sentence into note.txt.
Harbor check 1842.
Make Calculator show 1.
Then add a space and this sentence to the end of note.txt, and save again.
Shore check 1843.
When you finish, note.txt is one line, Harbor check 1842. Shore check 1843.
Calculator still shows 1.
```

## Start

Stop if TextEdit or Calculator is already running.

```sh
TASK_DIR="$(mktemp -d)"
: > "$TASK_DIR/note.txt"
open -a TextEdit "$TASK_DIR/note.txt"
open -a Calculator
osascript -e 'tell application "System Events" to key code 53'
```

`TASK_DIR` is for the harness. Do not put it in the goal.

Before you start the agent, `file-body` on `note.txt` prints nothing, and `calculator-display` prints `0`. If either check fails, the run is invalid.

## Grade

Run these from the harness after the agent stops. `GRADE` is `docs/scenarios/macos/grade.sh`.

```sh
test "$("$GRADE" file-body "$TASK_DIR/note.txt")" = "Harbor check 1842. Shore check 1843."
test "$("$GRADE" calculator-display)" = "1"
```

Both tests exit 0.

Quit Calculator. Quit TextEdit without saving any further edits.

```sh
osascript -e 'tell application "Calculator" to quit' -e 'tell application "TextEdit" to quit saving no'
```
