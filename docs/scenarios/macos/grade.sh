#!/bin/sh
# The agent does not run this. The harness reads the Mac after the agent stops.
set -eu

usage() {
  echo "usage: grade.sh calculator-display | file-body FILE | textedit-windows" >&2
  exit 2
}

[ $# -ge 1 ] || usage

case "$1" in
  calculator-display)
    osascript <<'APPLESCRIPT' | python3 -c 'import sys; sys.stdout.write(sys.stdin.read().replace("\u200e", "").strip())'
tell application "System Events" to tell process "Calculator"
  return value of static text 1 of scroll area 1 of group 1 of group 1 of splitter group 1 of group 1 of window 1 as text
end tell
APPLESCRIPT
    ;;
  file-body)
    [ $# -eq 2 ] || usage
    python3 - "$2" <<'PY'
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
if text.endswith("\n"):
    text = text[:-1]
if text.endswith("\r"):
    text = text[:-1]
sys.stdout.write(text)
PY
    ;;
  textedit-windows)
    osascript <<'APPLESCRIPT'
tell application "System Events" to tell process "TextEdit"
  set names to name of every window
end tell
if class of names is list then
  set AppleScript's text item delimiters to linefeed
  set out to names as text
  set AppleScript's text item delimiters to ""
  return out
end if
return names as text
APPLESCRIPT
    ;;
  *)
    usage
    ;;
esac
