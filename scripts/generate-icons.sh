#!/usr/bin/env bash
# Generate all binary icon and installer image assets from SVG sources.
#
# Requirements:
#   rsvg-convert  — sudo apt install librsvg2-bin  (or brew install librsvg on macOS)
#   electron-icon-builder — npm install -g electron-icon-builder
#
# Run once before building, or whenever assets/logo/icon.svg changes.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Rasterising master icon to build/icon.png (1024×1024)…"
rsvg-convert -w 1024 -h 1024 "$ROOT/assets/logo/icon.svg" > "$ROOT/build/icon.png"

echo "→ Generating build/icon.icns + build/icon.ico from build/icon.png…"
npx electron-icon-builder --input="$ROOT/build/icon.png" --output="$ROOT/build" --flatten

echo "→ Copying platform icons to assets/…"
cp "$ROOT/build/icons/mac/icon.icns" "$ROOT/assets/macos/app.icns"
cp "$ROOT/build/icons/win/icon.ico"  "$ROOT/assets/windows/app.ico"

echo "→ Generating Linux PNG sizes…"
for SIZE in 16 32 256; do
  rsvg-convert -w "$SIZE" -h "$SIZE" "$ROOT/assets/linux/icon.svg" \
    > "$ROOT/assets/linux/${SIZE}x${SIZE}.png"
done

echo "→ Generating installer images (PNG from SVG)…"
rsvg-convert -w 493 -h 58  "$ROOT/assets/installer/banner.svg"  > "$ROOT/assets/installer/banner.png"
rsvg-convert -w 164 -h 314 "$ROOT/assets/installer/sidebar.svg" > "$ROOT/assets/installer/sidebar.png"

echo "✓ All icons and installer images generated."
