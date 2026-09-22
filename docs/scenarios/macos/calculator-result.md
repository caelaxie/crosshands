# Show 81 on Calculator

Time limit 120 seconds. Follow the rules in [the suite readme](README.md).

## Goal

This is the only text the agent sees.

```text
Calculator is open and shows 0.
Make it show the result of 9 times 9.
The display is 81.
Leave the expression off the display.
```

## Start

Stop if Calculator is already running.

```sh
open -a Calculator
osascript -e 'tell application "System Events" to key code 53'
```

Before you start the agent, `calculator-display` prints `0`. If it does not, the run is invalid.

## Grade

Run this from the harness after the agent stops. `GRADE` is `docs/scenarios/macos/grade.sh`.

```sh
test "$("$GRADE" calculator-display)" = "81"
```

The test exits 0. A display of `9×9` or `9*9` fails.

Quit Calculator.

```sh
osascript -e 'tell application "Calculator" to quit'
```
