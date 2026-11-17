#!/bin/zsh
# Build the iOS app (Release) signed with your Apple Development team,
# install it on a connected iPhone or iPad, and launch it.
#
# Usage: scripts/install-ios.sh [team-id] [device-udid]
#
# The device defaults to the first paired physical iPhone or iPad. Signing is automatic
# (Xcode creates or refreshes the provisioning profiles), so the device must be
# registered with the team, or Xcode must be allowed to register it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Cookies"
BUNDLE_ID="dev.eyeb0l.cookies"
DERIVED="${TMPDIR:-/tmp}/cookies-install-ios-derived"

TEAM_ID="${1:-}"
if [[ -z "$TEAM_ID" ]]; then
  TEAM_ID="$(security find-certificate -c 'Apple Development' -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1)"
fi
if [[ -z "$TEAM_ID" ]]; then
  echo "No Apple Development certificate found; pass your team id as the first argument." >&2
  exit 1
fi

DEVICE="${2:-}"
if [[ -z "$DEVICE" ]]; then
  DEVICES_JSON="$(mktemp)"
  trap 'rm -f "$DEVICES_JSON"' EXIT
  xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null 2>&1
  DEVICE="$(python3 - "$DEVICES_JSON" <<'EOF'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
for d in devices:
    hw, conn = d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    if hw.get("platform") == "iOS" and hw.get("reality") == "physical" \
            and conn.get("pairingState") == "paired" and hw.get("udid"):
        print(hw["udid"])
        break
EOF
)"
fi
if [[ -z "$DEVICE" ]]; then
  echo "No paired iPhone or iPad found; connect one (and trust this Mac) or pass its UDID as the second argument." >&2
  exit 1
fi

rm -rf "$DERIVED"

xcodebuild -project "$ROOT/Cookies/Cookies.xcodeproj" -scheme "$APP_NAME (iOS)" -configuration Release \
  -destination "id=$DEVICE" -derivedDataPath "$DERIVED" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic build \
  | grep -E "error:|BUILD" || true

BUILT="$DERIVED/Build/Products/Release-iphoneos/$APP_NAME.app"
[[ -d "$BUILT" ]] || { echo "Build failed." >&2; exit 1; }
codesign --verify --deep --strict "$BUILT"

xcrun devicectl device install app --device "$DEVICE" "$BUILT"
rm -rf "$DERIVED"
xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID" >/dev/null

echo "Installed $APP_NAME ($BUNDLE_ID) on $DEVICE, team $TEAM_ID."
echo "Enable it in Settings → Apps → Safari → Extensions → $APP_NAME and allow it on all websites."
