#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUTPUT_APP=${1:-"$ROOT/../../packages/platform-darwin/assets/CrossHands Computer Use.app"}
IDENTITY=${CROSSHANDS_CODESIGN_IDENTITY:--}
BIN_DIR=$(swift build \
  --package-path "$ROOT" \
  --configuration release \
  --arch arm64 \
  --arch x86_64 \
  --show-bin-path)

swift build \
  --package-path "$ROOT" \
  --configuration release \
  --arch arm64 \
  --arch x86_64

rm -rf "$OUTPUT_APP"
mkdir -p "$OUTPUT_APP/Contents/MacOS" "$OUTPUT_APP/Contents/Resources"
cp "$ROOT/App/Info.plist" "$OUTPUT_APP/Contents/Info.plist"
cp "$BIN_DIR/crosshands-computer-use-macos" "$OUTPUT_APP/Contents/MacOS/crosshands-computer-use-macos"
chmod 0755 "$OUTPUT_APP/Contents/MacOS/crosshands-computer-use-macos"

lipo "$OUTPUT_APP/Contents/MacOS/crosshands-computer-use-macos" -verify_arch arm64 x86_64
set -- --force --sign "$IDENTITY" --identifier ai.crosshands.ComputerUse --options runtime
if [ "$IDENTITY" != "-" ]; then
  set -- "$@" --timestamp
fi
codesign "$@" "$OUTPUT_APP"
codesign --verify --strict --verbose=2 "$OUTPUT_APP"
