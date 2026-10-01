#!/usr/bin/env bash
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$PACKAGE_DIR/../../.." && pwd)"
BUILD_UTILS="$PACKAGE_DIR/scripts/build-utils.py"
cd "$REPO_DIR"
TARGET_DIR="$(cargo metadata --locked --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
mkdir -p "$TARGET_DIR"
BINDINGS_DIR="$(mktemp -d "$TARGET_DIR/rn-kotlin-bindings.XXXXXX")"
trap 'rm -rf "$BINDINGS_DIR"' EXIT
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$ANDROID_HOME/ndk/27.1.12297006}"
PROFILE="${PROFILE:-release}"
API_LEVEL="${API_LEVEL:-24}"

case "$(uname -s)" in
  Darwin) HOST_TAG=darwin-x86_64 ;;
  Linux) HOST_TAG=linux-x86_64 ;;
  *) printf 'Unsupported NDK host\n' >&2; exit 1 ;;
esac
TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG/bin"
if [[ ! -d "$TOOLCHAIN" ]]; then
  printf 'NDK not found at %s; set ANDROID_NDK_HOME.\n' "$ANDROID_NDK_HOME" >&2
  exit 1
fi

# Build the host library first so UniFFI emits bindings for both the core and
# its linked phoenix_channels_client component from the same library metadata.
cargo build --locked --manifest-path "$REPO_DIR/Cargo.toml" -p liveview-native-core
case "$(uname -s)" in
  Darwin) HOST_LIBRARY="$TARGET_DIR/debug/libliveview_native_core.dylib" ;;
  Linux) HOST_LIBRARY="$TARGET_DIR/debug/libliveview_native_core.so" ;;
esac
cargo run --locked --manifest-path "$REPO_DIR/Cargo.toml" -p uniffi-bindgen -- generate \
  --library "$HOST_LIBRARY" --language kotlin --out-dir "$BINDINGS_DIR"
# Always generate from the current checked library, then preserve identical
# source files so Gradle does not compile them again because their mtime moved.
python3 "$BUILD_UTILS" sync-tree "$BINDINGS_DIR" "$PACKAGE_DIR/android/src/main/java/generated"

if [[ $# -eq 0 ]]; then set -- arm64-v8a x86_64; fi
for ABI in "$@"; do
  case "$ABI" in
    arm64-v8a) RUST_TARGET=aarch64-linux-android; CLANG_TARGET=aarch64-linux-android ;;
    x86_64) RUST_TARGET=x86_64-linux-android; CLANG_TARGET=x86_64-linux-android ;;
    armeabi-v7a) RUST_TARGET=armv7-linux-androideabi; CLANG_TARGET=armv7a-linux-androideabi ;;
    x86) RUST_TARGET=i686-linux-android; CLANG_TARGET=i686-linux-android ;;
    *) printf 'Unsupported Android ABI: %s\n' "$ABI" >&2; exit 1 ;;
  esac
  rustup target add "$RUST_TARGET"
  TARGET_KEY="${RUST_TARGET//-/_}"
  TARGET_UPPER="$(printf '%s' "$TARGET_KEY" | tr '[:lower:]' '[:upper:]')"
  export "CARGO_TARGET_${TARGET_UPPER}_LINKER=$TOOLCHAIN/${CLANG_TARGET}${API_LEVEL}-clang"
  export "CC_${TARGET_KEY}=$TOOLCHAIN/${CLANG_TARGET}${API_LEVEL}-clang"
  export "AR_${TARGET_KEY}=$TOOLCHAIN/llvm-ar"
  export "RANLIB_${TARGET_KEY}=$TOOLCHAIN/llvm-ranlib"
  # Android devices can use 16 KiB pages; align the Rust shared library too.
  export "CARGO_TARGET_${TARGET_UPPER}_RUSTFLAGS=-C link-arg=-Wl,-z,max-page-size=16384"
  PATH="$TOOLCHAIN:$PATH" cargo build --locked --manifest-path "$REPO_DIR/Cargo.toml" \
    -p liveview-native-core --target "$RUST_TARGET" --profile "$PROFILE"
  OUTPUT_PROFILE="$PROFILE"
  if [[ "$PROFILE" == dev ]]; then OUTPUT_PROFILE=debug; fi
  mkdir -p "$PACKAGE_DIR/android/src/main/jniLibs/$ABI"
  python3 "$BUILD_UTILS" sync-file "$TARGET_DIR/$RUST_TARGET/$OUTPUT_PROFILE/libliveview_native_core.so" \
    "$PACKAGE_DIR/android/src/main/jniLibs/$ABI/libliveview_native_core.so"
done
