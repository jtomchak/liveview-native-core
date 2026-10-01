#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$package_dir/../../.." && pwd)"
build_utils="$package_dir/scripts/build-utils.py"
PROFILE="${PROFILE:-dev}"
case "$PROFILE" in
  dev) output_profile=debug ;;
  release) output_profile=release ;;
  *) printf 'iOS PROFILE must be dev or release.\n' >&2; exit 1 ;;
esac
cd "$repo_dir"
target_dir="$(cargo metadata --locked --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
mkdir -p "$target_dir"
artifact_dir="$(mktemp -d "$target_dir/rn-ios-build.XXXXXX")"
trap 'rm -rf "$artifact_dir"' EXIT

# Cargo checks source, dependency, configuration and toolchain inputs every run.
# Bindgen uses the host dev library; packaged device libraries use PROFILE.
cargo build --locked -p liveview-native-core
cargo run --locked -p uniffi-bindgen -- generate \
  --library "$target_dir/debug/libliveview_native_core.a" --language swift \
  --out-dir "$artifact_dir/generated"
cat "$artifact_dir/generated/LiveViewNativeCoreFFI.modulemap" \
    "$artifact_dir/generated/PhoenixChannelsClientFFI.modulemap" \
    > "$artifact_dir/generated/module.modulemap"
python3 "$build_utils" sync-tree "$artifact_dir/generated" "$package_dir/ios/generated"

export IPHONEOS_DEPLOYMENT_TARGET=16.4
cargo build --locked -p liveview-native-core --target aarch64-apple-ios-sim --profile "$PROFILE"
cargo build --locked -p liveview-native-core --target aarch64-apple-ios --profile "$PROFILE"
simulator_library="$target_dir/aarch64-apple-ios-sim/$output_profile/libliveview_native_core.a"
device_library="$target_dir/aarch64-apple-ios/$output_profile/libliveview_native_core.a"
framework="$package_dir/ios/frameworks/liveview_native_core.xcframework"
state="$package_dir/ios/frameworks/.liveview_native_core.inputs.json"
key="$(python3 "$build_utils" input-key "$PROFILE" "$simulator_library" "$device_library" \
  "$package_dir"/ios/generated/*.h "$package_dir/ios/generated/module.modulemap")"
if [[ "${LVN_FORCE_REBUILD:-0}" != 1 ]] && python3 "$build_utils" package-valid "$state" "$key" "$framework"; then
  printf 'Reusing unchanged %s XCFramework.\n' "$PROFILE"
else
  mkdir -p "$artifact_dir/headers"
  cp "$package_dir"/ios/generated/*.h "$artifact_dir/headers/"
  cp "$package_dir/ios/generated/module.modulemap" "$artifact_dir/headers/"
  xcodebuild -create-xcframework \
    -library "$simulator_library" -headers "$artifact_dir/headers" \
    -library "$device_library" -headers "$artifact_dir/headers" \
    -output "$artifact_dir/liveview_native_core.xcframework"
  python3 "$build_utils" sync-tree "$artifact_dir/liveview_native_core.xcframework" "$framework"
  python3 "$build_utils" record-package "$state" "$key" "$framework"
fi
