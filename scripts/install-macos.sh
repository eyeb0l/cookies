#!/bin/zsh
# Build the macOS app (Release) signed with the first "Apple Development"
# identity in the keychain, install it to /Applications, and make sure only
# that copy is registered with Launch Services and PlugInKit.
#
# Usage: scripts/install-macos.sh [team-id]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Cookies"
BUNDLE_ID="dev.eyeb0l.cookies"
DERIVED="${TMPDIR:-/tmp}/cookies-install-derived"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

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

osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
rm -rf "$DERIVED"

xcodebuild -project "$ROOT/Cookies/Cookies.xcodeproj" -scheme "$APP_NAME (macOS)" -configuration Release \
  -derivedDataPath "$DERIVED" DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="Apple Development" PROVISIONING_PROFILE_SPECIFIER="" build \
  | grep -E "error:|BUILD" || true

BUILT="$DERIVED/Build/Products/Release/$APP_NAME.app"
[[ -d "$BUILT" ]] || { echo "Build failed." >&2; exit 1; }
codesign --verify --deep --strict "$BUILT"

rm -rf "/Applications/$APP_NAME.app"
ditto "$BUILT" "/Applications/$APP_NAME.app"

# Keep the build products from showing up as a second copy in Safari.
"$LSREGISTER" -u "$BUILT" >/dev/null 2>&1 || true
rm -rf "$DERIVED"
"$LSREGISTER" -f "/Applications/$APP_NAME.app" >/dev/null 2>&1 || true
pluginkit -a "/Applications/$APP_NAME.app/Contents/PlugIns/$APP_NAME Extension.appex" >/dev/null 2>&1 || true

echo "Installed /Applications/$APP_NAME.app ($BUNDLE_ID), team $TEAM_ID."
echo "Registered extension copies:"
pluginkit -m -v -i "$BUNDLE_ID.Extension"
open "/Applications/$APP_NAME.app"
