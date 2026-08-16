#!/bin/bash
# Notarize and staple the built DMG so the disk image itself passes Gatekeeper,
# not only the app inside it. electron-builder notarizes and staples the .app
# but builds the DMG afterwards, so the image needs its own ticket.
#
# Requires a stored notarytool keychain profile:
#   xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team> --password <app-specific>
# Pass the profile name via APPLE_KEYCHAIN_PROFILE (default: wiley-notary).
set -euo pipefail

PROFILE="${APPLE_KEYCHAIN_PROFILE:-wiley-notary}"
DMG="${1:-$(ls release/Wiley-*.dmg 2>/dev/null | head -1)}"

[ -f "$DMG" ] || { echo "No DMG found (looked for release/Wiley-*.dmg)"; exit 1; }

echo "Notarizing $DMG with profile $PROFILE"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
spctl -a -vvv -t install "$DMG"
