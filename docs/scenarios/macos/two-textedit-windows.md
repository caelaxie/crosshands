# Keep two TextEdit files apart

Time limit 180 seconds. Follow the rules in [the suite readme](README.md).

## Goal

This is the only text the agent sees.

```text
Two TextEdit windows are open. One document is a.txt and the other is b.txt. Both are empty.
Write this sentence into a.txt and save it.
Harbor check 1842.
Leave b.txt empty.
Close the a.txt window.
Leave the b.txt window open.
Do not change either file after you close a.txt.
```

## Start

Stop if TextEdit is already running.

```sh
TASK_DIR="$(mktemp -d)"
: > "$TASK_DIR/a.txt"
: > "$TASK_DIR/b.txt"
open -a TextEdit "$TASK_DIR/a.txt" "$TASK_DIR/b.txt"
```

`TASK_DIR` is for the harness. Do not put it in the goal.

Before you start the agent, `file-body` on both files prints nothing, and `textedit-windows` prints both `a.txt` and `b.txt`. If either check fails, the run is invalid.

## Grade

Run these from the harness after the agent stops. `GRADE` is `docs/scenarios/macos/grade.sh`.

```sh
test "$("$GRADE" file-body "$TASK_DIR/a.txt")" = "Harbor check 1842."
test "$("$GRADE" file-body "$TASK_DIR/b.txt")" = ""
"$GRADE" textedit-windows > "$TASK_DIR/windows.txt"
! grep -F -x 'a.txt' "$TASK_DIR/windows.txt"
grep -F -x 'b.txt' "$TASK_DIR/windows.txt"
```

Every command exits 0.

Quit TextEdit without saving any further edits.

```sh
osascript -e 'tell application "TextEdit" to quit saving no'
```
