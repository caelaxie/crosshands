# macOS computer-use tasks

These tasks score the Mac after an agent stops. They do not name a computer-use product. The agent may click, type, use menus, use accessibility actions, or use screenshots. The agent may not receive these files, the grader, or the task paths.

You run the harness. The agent sees only the goal in the task file.

## Rules

Give the agent the goal and nothing else from this directory.

The agent may operate the open apps through the graphical session. Pasting into a document through the GUI is allowed. Keystrokes sent to the front app are allowed.

The agent may not write, truncate, or replace the task files from the shell or from another program. The agent may not set a TextEdit document's text through AppleScript. The agent may not assign Calculator's display. The agent may not read or edit the grader.

If TextEdit or Calculator is already running, stop. Do not quit apps you did not start. A run that begins with either app open is invalid.

A run that passes the time limit is a fail. Stop the agent and grade the Mac as it is.

## Reset and grade

`grade.sh` in this directory is the grader. The agent does not run it.

`calculator-display` prints the Calculator display. The printed text has the leading `U+200E` mark removed. The path is the static text in the display's scroll area, read on this Mac with the basic window and the sidebar closed. If the command errors, the run is invalid at reset and a fail at grade time.

`file-body FILE` prints the file with one trailing newline removed. Compare that text to the expected body.

`textedit-windows` prints the TextEdit window names, one on each line.

Reset Calculator to `0` before a task that uses it.

```sh
open -a Calculator
osascript -e 'tell application "System Events" to key code 53'
docs/scenarios/macos/grade.sh calculator-display
```

The last command must print `0`. If it does not, the run is invalid.

Run `chmod +x docs/scenarios/macos/grade.sh` once if the script is not executable.

## Tasks

- [Keep two TextEdit files apart](two-textedit-windows.md). Time limit 180 seconds.
- [Type in TextEdit, then use Calculator](textedit-and-calculator.md). Time limit 180 seconds.
- [Show 81 on Calculator](calculator-result.md). Time limit 120 seconds.
