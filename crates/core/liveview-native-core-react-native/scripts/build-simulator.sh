#!/usr/bin/env bash
set -euo pipefail

# Simulator-only ad-hoc identity: never use these entitlements for a device.
# Generate the example's iOS workspace/pods before running this helper.
package_dir="$(cd "$(dirname "$0")/.." && pwd)"
ios_dir="$package_dir/example/ios"
if [[ ! -d "$ios_dir/LiveViewNativeRN.xcworkspace" ]]; then
  printf 'Generate the iOS example workspace with Expo prebuild first.\n' >&2
  exit 1
fi
if [[ $# -gt 1 ]]; then
  printf 'Usage: bash scripts/build-simulator.sh [simulator-udid]\n' >&2
  exit 1
fi
simulator_id="${1:-${SIMULATOR_UDID:-}}"
destination="generic/platform=iOS Simulator"
if [[ -n "$simulator_id" ]]; then
  if [[ ! "$simulator_id" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]]; then
    printf 'Expected a simulator UUID. Physical device builds require normal provisioning.\n' >&2
    exit 1
  fi
  destination="id=$simulator_id"
fi

bash "$package_dir/scripts/build-ios.sh"
mkdir -p "$ios_dir/build"
signing_dir="$(mktemp -d "$ios_dir/build/lvn-simulator-signing.XXXXXX")"
trap 'rm -rf "$signing_dir"' EXIT
entitlements="$signing_dir/keychain.entitlements"
python3 - "$package_dir/example/app.json" "$entitlements" <<'PY'
import json
import plistlib
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    bundle_id = json.load(source)["expo"]["ios"]["bundleIdentifier"]
with open(sys.argv[2], "wb") as destination:
    plistlib.dump({
        "application-identifier": bundle_id,
        "keychain-access-groups": [bundle_id],
    }, destination)
PY

cd "$ios_dir"
xcodebuild -workspace LiveViewNativeRN.xcworkspace -scheme LiveViewNativeRN \
  -configuration Debug -sdk iphonesimulator -destination "$destination" \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  "CODE_SIGN_ENTITLEMENTS=$entitlements" build
