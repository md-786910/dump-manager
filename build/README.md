# Build resources

`electron-builder` auto-detects icons placed in this directory.

## Required for beta builds

Drop **one** 1024×1024 PNG of your app icon here as `icon.png`, then run:

```bash
npx electron-icon-builder --input=build/icon.png --output=build --flatten
```

This produces:
- `icon.icns` (macOS, multi-resolution)
- `icon.ico` (Windows)
- `icon.png` (Linux — overwritten from the source if `--flatten`)
- Intermediate `icons/` directory (gitignored)

The `electron-builder.yml` config picks these up automatically.

## Optional

- `background.png` (540×380) — DMG installer background. Falls back to a plain gradient if absent.
- `entitlements.mac.plist` — macOS entitlements for code-signing. Not needed until you start signing builds.

## Beta placeholder

If you don't yet have an icon, the build still succeeds — electron-builder ships a default Electron icon. Just don't ship the public beta without a real one.
