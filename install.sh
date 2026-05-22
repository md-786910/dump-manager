#!/usr/bin/env bash
# Tunnex installer — macOS and Linux
# Usage: curl -fsSL https://tunnex.biz/install.sh | bash

set -euo pipefail

RELEASES_URL="https://pub-d098ab4c32934fd196eb5acec30a1f42.r2.dev/releases"

# ── helpers ──────────────────────────────────────────────────────────────────

info()  { printf '\033[1;34m==> \033[0m%s\n' "$*"; }
ok()    { printf '\033[1;32m  ✓ \033[0m%s\n' "$*"; }
warn()  { printf '\033[1;33m  ! \033[0m%s\n' "$*"; }
err()   { printf '\033[1;31mError: \033[0m%s\n' "$*" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ── macOS ─────────────────────────────────────────────────────────────────────

install_mac() {
  # Downloads the latest zip via curl (no quarantine flag), extracts, and
  # installs Tunnex.app to /Applications.
  local LATEST_YML_URL="$RELEASES_URL/latest-mac.yml"
  local INSTALL_DIR="/Applications"

  local ARCH
  ARCH="$(uname -m)"
  local ZIP_ARCH
  case "$ARCH" in
    arm64)  ZIP_ARCH="arm64" ;;
    x86_64) ZIP_ARCH="x64" ;;
    *)      err "Unsupported architecture: $ARCH" ;;
  esac

  info "Checking for latest Tunnex release…"
  local LATEST_YML
  LATEST_YML="$(curl -fsSL "$LATEST_YML_URL")" \
    || err "Could not fetch release info from $LATEST_YML_URL"

  local VERSION
  VERSION="$(printf '%s' "$LATEST_YML" | grep '^version:' | head -1 | sed 's/version: *//')"
  [ -n "$VERSION" ] || err "Could not parse version from latest-mac.yml"

  local ZIP_NAME="Tunnex-${VERSION}-mac-${ZIP_ARCH}.zip"
  local ZIP_URL="$RELEASES_URL/$ZIP_NAME"

  info "Installing Tunnex $VERSION ($ZIP_ARCH)…"

  info "Downloading $ZIP_NAME…"
  curl -fSL --progress-bar "$ZIP_URL" -o "$TMP_DIR/$ZIP_NAME" \
    || err "Download failed: $ZIP_URL"
  ok "Downloaded $ZIP_NAME"

  info "Extracting…"
  unzip -q "$TMP_DIR/$ZIP_NAME" -d "$TMP_DIR/extracted" \
    || err "Extraction failed"

  local APP_SRC
  APP_SRC="$(find "$TMP_DIR/extracted" -maxdepth 2 -name 'Tunnex.app' | head -1)"
  [ -d "$APP_SRC" ] || err "Tunnex.app not found in zip"

  # curl doesn't add quarantine, but clear it belt-and-suspenders
  xattr -rd com.apple.quarantine "$APP_SRC" 2>/dev/null || true
  ok "Quarantine attribute cleared"

  local APP_DEST="$INSTALL_DIR/Tunnex.app"
  if [ -d "$APP_DEST" ]; then
    info "Removing existing Tunnex.app…"
    rm -rf "$APP_DEST"
  fi

  info "Installing to $INSTALL_DIR…"
  cp -R "$APP_SRC" "$APP_DEST" \
    || err "Could not copy to $INSTALL_DIR — try running with sudo"
  ok "Tunnex.app installed to $INSTALL_DIR"

  printf '\n\033[1;32mTunnex %s installed successfully!\033[0m\n' "$VERSION"
  printf 'Open it from your Applications folder or run: open /Applications/Tunnex.app\n\n'
}

# ── Linux ─────────────────────────────────────────────────────────────────────

install_linux_deb() {
  local VERSION="$1"
  # electron-builder names .deb artifacts with "amd64" regardless of our arch variable
  local DEB_NAME="Tunnex-${VERSION}-linux-amd64.deb"
  local DEB_URL="$RELEASES_URL/$DEB_NAME"

  info "Downloading $DEB_NAME…"
  curl -fSL --progress-bar "$DEB_URL" -o "$TMP_DIR/$DEB_NAME" \
    || err "Download failed: $DEB_URL"
  ok "Downloaded $DEB_NAME"

  info "Installing with dpkg (requires sudo)…"
  sudo dpkg -i "$TMP_DIR/$DEB_NAME" \
    || { warn "dpkg install failed — trying apt-get install -f…"; sudo apt-get install -f -y; }
  ok "Tunnex installed via .deb"

  printf '\n\033[1;32mTunnex %s installed successfully!\033[0m\n' "$VERSION"
  printf 'Launch it from your application menu or run: tunnex\n\n'
}

install_linux_appimage() {
  local VERSION="$1" FILE_ARCH="$2"
  local APPIMAGE_NAME="Tunnex-${VERSION}-linux-${FILE_ARCH}.AppImage"
  local APPIMAGE_URL="$RELEASES_URL/$APPIMAGE_NAME"

  local INSTALL_DIR="${HOME}/.local/bin"
  mkdir -p "$INSTALL_DIR"
  local DEST="$INSTALL_DIR/tunnex"

  info "Downloading $APPIMAGE_NAME…"
  curl -fSL --progress-bar "$APPIMAGE_URL" -o "$TMP_DIR/$APPIMAGE_NAME" \
    || err "Download failed: $APPIMAGE_URL"
  ok "Downloaded $APPIMAGE_NAME"

  info "Installing to $DEST…"
  cp "$TMP_DIR/$APPIMAGE_NAME" "$DEST"
  chmod +x "$DEST"
  ok "Tunnex installed to $DEST"

  # Warn if ~/.local/bin is not on PATH
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *) warn "$INSTALL_DIR is not in your PATH. Add this to your shell profile:"
       warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
       ;;
  esac

  printf '\n\033[1;32mTunnex %s installed successfully!\033[0m\n' "$VERSION"
  printf 'Run it with: tunnex\n\n'
}

install_linux() {
  local LATEST_YML_URL="$RELEASES_URL/latest-linux.yml"

  local ARCH
  ARCH="$(uname -m)"
  local FILE_ARCH
  case "$ARCH" in
    x86_64)        FILE_ARCH="x64" ;;
    aarch64|arm64) err "ARM64 Linux is not yet published. Download manually at https://tunnex.biz/download" ;;
    *)             err "Unsupported architecture: $ARCH" ;;
  esac

  info "Checking for latest Tunnex release…"
  local LATEST_YML
  LATEST_YML="$(curl -fsSL "$LATEST_YML_URL")" \
    || err "Could not fetch release info from $LATEST_YML_URL"

  local VERSION
  VERSION="$(printf '%s' "$LATEST_YML" | grep '^version:' | head -1 | sed 's/version: *//')"
  [ -n "$VERSION" ] || err "Could not parse version from latest-linux.yml"

  info "Installing Tunnex $VERSION ($ARCH)…"

  # Prefer .deb on Debian/Ubuntu; fall back to AppImage everywhere else
  if command -v dpkg >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
    install_linux_deb "$VERSION"
  else
    install_linux_appimage "$VERSION" "$FILE_ARCH"
  fi
}

# ── dispatch ──────────────────────────────────────────────────────────────────

case "$(uname)" in
  Darwin) install_mac ;;
  Linux)  install_linux ;;
  *)      err "Unsupported OS: $(uname). Download manually at https://tunnex.biz/download" ;;
esac
