#!/bin/sh
set -eu

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$HERE/../.." && pwd)"
BUILD="$HERE/build"
OUTPUT="$ROOT/ios/Vendor/PiRemoteTailcat.xcframework"
if [ "$#" -ge 1 ]; then
  OUTPUT="$1"
fi

cd "$HERE"

chmod +x   "$HERE/scripts/clangwrap-ios.sh"   "$HERE/scripts/clangwrap-ios-sim-arm64.sh"   "$HERE/scripts/clangwrap-ios-sim-x86_64.sh"

rm -rf "$BUILD" "$OUTPUT"
mkdir -p   "$BUILD/device"   "$BUILD/sim-arm64"   "$BUILD/sim-x86_64"   "$BUILD/simulator"   "$BUILD/headers"   "$(dirname "$OUTPUT")"

export CGO_ENABLED=1
export GOFLAGS="-mod=mod"

GOOS=ios GOARCH=arm64   CC="$HERE/scripts/clangwrap-ios.sh"   go build -trimpath -tags ios -buildmode=c-archive     -o "$BUILD/device/libPiRemoteTailcat.a" .

GOOS=ios GOARCH=arm64   CC="$HERE/scripts/clangwrap-ios-sim-arm64.sh"   go build -trimpath -tags ios -buildmode=c-archive     -o "$BUILD/sim-arm64/libPiRemoteTailcat.a" .

GOOS=ios GOARCH=amd64   CC="$HERE/scripts/clangwrap-ios-sim-x86_64.sh"   go build -trimpath -tags ios -buildmode=c-archive     -o "$BUILD/sim-x86_64/libPiRemoteTailcat.a" .

lipo -create   "$BUILD/sim-arm64/libPiRemoteTailcat.a"   "$BUILD/sim-x86_64/libPiRemoteTailcat.a"   -output "$BUILD/simulator/libPiRemoteTailcat.a"

cp "$BUILD/device/libPiRemoteTailcat.h"   "$BUILD/headers/PiRemoteTailcat.h"

cat > "$BUILD/headers/module.modulemap" <<'EOF'
module PiRemoteTailcat {
  header "PiRemoteTailcat.h"
  export *
}
EOF

xcodebuild -create-xcframework   -library "$BUILD/device/libPiRemoteTailcat.a"   -headers "$BUILD/headers"   -library "$BUILD/simulator/libPiRemoteTailcat.a"   -headers "$BUILD/headers"   -output "$OUTPUT"

echo "Created $OUTPUT"
