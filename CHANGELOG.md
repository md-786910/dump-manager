# Changelog

All notable changes to Tunnex are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.15] - 2026-05-16

### Added
- App icons across all platforms.

## [0.1.14] - 2026-05-16

### Added
- View all databases on a target server, not just the active one.
- MongoDB restore: dynamic database filtering at restore time.

### Fixed
- MongoDB backup reliability fixes.
- MongoDB data viewer rendering issues.
- Linux build not opening on some distributions.

## [0.1.13] - 2026-05-15

### Added
- Hamburger menu on the marketing site for mobile devices.
- Open Graph image for social sharing.
- Updated app icon and website hero imagery.

## [0.1.12] - 2026-05-15

### Fixed
- GitHub Actions release pipeline now publishes to R2 correctly.

## [0.1.11] - 2026-05-15

### Added
- Google Tag for site analytics.

### Fixed
- Synchronous signing of R2 upload requests.

## [0.1.10] - 2026-05-15

### Changed
- Split builds cleanly: GitHub Actions for Windows + macOS, Codemagic for Linux.

## [0.1.9] - 2026-05-15

### Changed
- Renamed app for production.

### Added
- Initial README.md.
- `run.sh` helper for local development.

## [0.1.8] - 2026-05-15

### Added
- Hybrid CI: Codemagic (Linux, free tier) plus GitHub Actions (Windows + macOS).
- Site rebuild trigger from all three platform jobs.

## [0.1.7] - 2026-05-15

### Added
- Codemagic webhook setup instructions.
- `cancel_previous_builds` flag on CI.

## [0.1.6] - 2026-05-15

### Added
- Codemagic variable group wired into all three workflows.
- Codemagic pipeline for all three platforms.

## [0.1.5] - 2026-05-15

### Fixed
- Stripped R2-incompatible checksum headers via middleware.

## [0.1.4] - 2026-05-15

### Fixed
- `shell: true` added to electron-builder spawn for Windows compatibility.

## [0.1.3] - 2026-05-15

### Fixed
- Release pipeline cleanup.

## [0.1.2] - 2026-05-15

### Fixed
- Pass `ContentLength` to R2 `PutObjectCommand` for correct multipart uploads.

## [0.1.1] - 2026-05-15

### Added
- Initial public beta.
- PostgreSQL and MongoDB backup and restore.
- SSH tunneling and direct URI support.
- AES-256-GCM streaming encryption.
- OS keychain integration (macOS Keychain, Windows Credential Manager, Linux SecretService).
- MongoDB backup viewer (read-only).
- Immutable audit log.
- Cross-platform installers (Windows, macOS, Linux).
- Auto-update via `electron-updater`.

[Unreleased]: https://github.com/md-786910/dump-manager/compare/v0.1.15...HEAD
[0.1.15]: https://github.com/md-786910/dump-manager/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/md-786910/dump-manager/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/md-786910/dump-manager/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/md-786910/dump-manager/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/md-786910/dump-manager/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/md-786910/dump-manager/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/md-786910/dump-manager/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/md-786910/dump-manager/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/md-786910/dump-manager/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/md-786910/dump-manager/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/md-786910/dump-manager/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/md-786910/dump-manager/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/md-786910/dump-manager/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/md-786910/dump-manager/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/md-786910/dump-manager/releases/tag/v0.1.1
