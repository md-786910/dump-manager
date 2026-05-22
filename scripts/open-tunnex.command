#!/bin/bash
# Tunnex first-launch helper for macOS
# Double-click this file if macOS says "Tunnex can't be opened".
# It removes the quarantine flag Apple sets on downloaded files, then launches the app.

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="$APP_DIR/Tunnex.app"

if [ ! -d "$APP_PATH" ]; then
  osascript -e 'display alert "Tunnex.app was not found in this folder.\nMake sure Tunnex.app and this file are in the same location." as critical'
  exit 1
fi

echo "Removing macOS quarantine flag from Tunnex.app..."
xattr -rd com.apple.quarantine "$APP_PATH"

if [ $? -ne 0 ]; then
  echo "Could not remove quarantine flag. Try running:"
  echo "  xattr -rd com.apple.quarantine \"$APP_PATH\""
  exit 1
fi

echo "Done. Launching Tunnex..."
open "$APP_PATH"
