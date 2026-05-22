# homebrew-tunnex

Homebrew tap for [Tunnex](https://tunnex.biz) — secure Postgres & Mongo backup/restore desktop app.

## Install

```bash
brew tap tunnex-biz/tunnex https://github.com/tunnex-biz/homebrew-tunnex
brew install --cask tunnex
```

The cask automatically removes the macOS quarantine flag so the app opens without a Gatekeeper warning.

## Update the cask for a new release

1. Update `version` in `Casks/tunnex.rb`
2. Generate new SHA256:
   ```bash
   shasum -a 256 Tunnex-<version>-mac-arm64.zip
   shasum -a 256 Tunnex-<version>-mac-x64.zip
   ```
3. Replace the `sha256 :no_check` placeholders with real values
4. Commit and push
