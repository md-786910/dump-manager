#!/usr/bin/env bash
# Tunnex macOS installer
# Usage: curl -fsSL https://tunnex.biz/install.sh | bash
#
# Downloads the latest Tunnex release zip directly via curl (which does NOT
# attach macOS quarantine flags), removes any residual quarantine attribute,
# and installs Tunnex.app to /Applications.
#
# Because the app is ad-hoc signed and arrives without the quarantine flag,
# Gatekeeper's notarization check is not triggered. The app opens normally.

set -euo pipefail

RELEASES_URL="https://pub-d098ab4c32934fd196eb5acec30a1f42.r2.dev/releases"
LATEST_YML_URL="$RELEASES_URL/latest-mac.yml"
INSTALL_DIR="/Applications"
TMP_DIR="$(mktemp -d)"

# ── helpers ──────────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m==> \033[0m%s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓ \033[0m%s\n' "$*"; }
err()   { printf '\033[1;31mError: \033[0m%s\n' "$*" >&2; exit 1; }

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ── platform check ───────────────────────────────────────────────────────────

[ "$(uname)" = "Darwin" ] || err "This installer is for macOS only."

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  ZIP_ARCH="arm64" ;;
  x86_64) ZIP_ARCH="x64" ;;
  *)      err "Unsupported architecture: $ARCH" ;;
esac

# ── fetch latest version ─────────────────────────────────────────────────────

info "Checking for latest Tunnex release…"
LATEST_YML="$(curl -fsSL "$LATEST_YML_URL")" \
  || err "Could not fetch release info from $LATEST_YML_URL"

VERSION="$(printf '%s' "$LATEST_YML" | grep '^version:' | head -1 | sed 's/version: *//')"
[ -n "$VERSION" ] || err "Could not parse version from latest-mac.yml"

ZIP_NAME="Tunnex-${VERSION}-mac-${ZIP_ARCH}.zip"
ZIP_URL="$RELEASES_URL/$ZIP_NAME"

info "Installing Tunnex $VERSION ($ZIP_ARCH)…"

# ── download ─────────────────────────────────────────────────────────────────

info "Downloading $ZIP_NAME…"
curl -fSL --progress-bar "$ZIP_URL" -o "$TMP_DIR/$ZIP_NAME" \
  || err "Download failed: $ZIP_URL"
ok "Downloaded $ZIP_NAME"

# ── extract ──────────────────────────────────────────────────────────────────

info "Extracting…"
unzip -q "$TMP_DIR/$ZIP_NAME" -d "$TMP_DIR/extracted" \
  || err "Extraction failed"

APP_SRC="$(find "$TMP_DIR/extracted" -maxdepth 2 -name 'Tunnex.app' | head -1)"
[ -d "$APP_SRC" ] || err "Tunnex.app not found in zip"

# ── remove quarantine (curl doesn't add it, but belt-and-suspenders) ─────────

xattr -rd com.apple.quarantine "$APP_SRC" 2>/dev/null || true
ok "Quarantine attribute cleared"

# ── install to /Applications ─────────────────────────────────────────────────

APP_DEST="$INSTALL_DIR/Tunnex.app"

if [ -d "$APP_DEST" ]; then
  info "Removing existing Tunnex.app…"
  rm -rf "$APP_DEST"
fi

info "Installing to $INSTALL_DIR…"
cp -R "$APP_SRC" "$APP_DEST" \
  || err "Could not copy to $INSTALL_DIR — try running with sudo"
ok "Tunnex.app installed to $INSTALL_DIR"

# ── done ─────────────────────────────────────────────────────────────────────

printf '\n\033[1;32mTunnex %s installed successfully!\033[0m\n' "$VERSION"
printf 'Open it from your Applications folder or run: open /Applications/Tunnex.app\n\n'
