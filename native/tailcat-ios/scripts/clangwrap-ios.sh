#!/bin/sh
set -eu

SDK=iphoneos
SDK_PATH="$(xcrun --sdk "$SDK" --show-sdk-path)"
CLANG="$(xcrun --sdk "$SDK" --find clang)"

exec "$CLANG" -arch arm64 -isysroot "$SDK_PATH" -mios-version-min=17.0 "$@"
