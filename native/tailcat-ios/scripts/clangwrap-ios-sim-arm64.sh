#!/bin/sh
set -eu

SDK=iphonesimulator
SDK_PATH="$(xcrun --sdk "$SDK" --show-sdk-path)"
CLANG="$(xcrun --sdk "$SDK" --find clang)"

exec "$CLANG" -arch arm64 -isysroot "$SDK_PATH" -mios-simulator-version-min=17.0 "$@"
