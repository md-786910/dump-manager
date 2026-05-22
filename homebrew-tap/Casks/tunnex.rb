cask "tunnex" do
  arch arm: "arm64", intel: "x64"

  version "0.1.17"

  # SHA256 checksums — update these each release (scripts/release.js can output them).
  # Generate with: shasum -a 256 Tunnex-<version>-mac-<arch>.zip
  on_arm do
    url "https://pub-d098ab4c32934fd196eb5acec30a1f42.r2.dev/releases/Tunnex-#{version}-mac-arm64.zip"
    sha256 :no_check   # replace with real sha256 after first release
  end
  on_intel do
    url "https://pub-d098ab4c32934fd196eb5acec30a1f42.r2.dev/releases/Tunnex-#{version}-mac-x64.zip"
    sha256 :no_check   # replace with real sha256 after first release
  end

  name "Tunnex"
  desc "Secure desktop tool for backing up and restoring Postgres & Mongo databases"
  homepage "https://tunnex.biz"

  app "Tunnex.app"

  # Remove quarantine flag so Gatekeeper doesn't block the ad-hoc signed app.
  postflight do
    system_command "/usr/bin/xattr",
      args: ["-rd", "com.apple.quarantine", "#{appdir}/Tunnex.app"],
      sudo: false
  end

  uninstall quit: "com.tunnex.app",
            delete: "#{appdir}/Tunnex.app"

  zap trash: [
    "~/Library/Application Support/tunnex",
    "~/Library/Logs/tunnex",
    "~/Library/Preferences/com.tunnex.app.plist",
  ]
end
