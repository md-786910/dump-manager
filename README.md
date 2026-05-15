# Tunnex - Secure Database Backup Manager

A **secure, open-source desktop application** for backing up and restoring PostgreSQL and MongoDB databases on Docker-based VPS deployments or external databases with enterprise-grade security and comprehensive audit logging.

**Version:** 0.1.8 | **Platform:** Cross-platform (Windows, macOS, Linux)

---

## Table of Contents

- [Overview](#overview)
- [Problems Solved](#problems-solved)
- [Key Features](#key-features)
- [Technical Architecture](#technical-architecture)
- [Technology Stack](#technology-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Development](#development)
- [Building](#building)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

Tunnex is a **production-ready desktop backup and recovery tool** designed for teams managing containerized databases on remote VPS infrastructure. It provides a modern, intuitive interface for managing database backups across multiple servers and targets, eliminating the complexity and security risks of manual CLI-based backup workflows.

### Target Use Cases

- **DevOps Teams:** Manage database backups across multiple staging and production environments
- **SaaS Operators:** Automate backup scheduling and recovery for Docker-based deployments
- **Database Administrators:** Monitor backup health, validate data integrity, and perform disaster recovery
- **Security-Conscious Organizations:** Encrypted at-rest backups with audit trail logging

---

## Problems Solved

### 🔐 Security Gaps in Existing Solutions

**Problem:** Traditional CLI-based backup tools (`pg_dump`, `mongodump`) expose credentials in shell history and process listings.

**Solution:**

- Credentials are stored in encrypted keychain storage and never exposed to shell environments
- Direct memory-to-file encryption eliminates temporary plaintext dump files on disk
- SSH private keys are protected with passphrase caching and optional pin-protected storage

### 📊 Multi-Server Backup Orchestration

**Problem:** Managing backups across 5+ environments requires custom scripts and error-prone manual synchronization.

**Solution:**

- Centralized server registry with support for SSH, Docker Compose, and external URI connections
- Queue-based backup execution prevents parallel SSH sessions that overwhelm sshd rate limiting
- Per-server backup history with size tracking and timestamp validation

### 🔍 Operator Visibility & Compliance

**Problem:** No audit trail of who performed what backup operation, when, and on which database.

**Solution:**

- **Immutable audit log** with timestamp, operator, target, and operation status
- Real-time progress tracking with byte counters for large database backups
- Full recovery state history including restore location and completion status

### 🎯 Database Viewer Without Exposure

**Problem:** Viewing backup contents requires extracting files or running unsafe `mongorestore --dryrun`.

**Solution:**

- **Browser-based database viewer** for MongoDB backups (read-only)
- Direct query interface without restoring to a temporary database
- Integrated connection testing to validate target databases before operations

### 🔄 Migration & Legacy System Support

**Problem:** Migrating databases between incompatible servers is error-prone (version mismatches, connection timeouts).

**Solution:**

- Automated database discovery on servers (detects running MongoDB, PostgreSQL containers)
- Connection pre-flight validation with diagnostic error messages
- Docker socket detection and automatic `sudo` elevation for Docker operations

---

## Key Features

### Backup Operations

- ✅ **PostgreSQL Backups** via `pg_dump` (Docker or direct Postgres URIs)
- ✅ **MongoDB Backups** via `mongodump` (Docker or external MongoDB URIs)
- ✅ **Streaming Encryption** — no temporary plaintext files on disk
- ✅ **SSH Tunneling** — automatic SSH session management with known-hosts TOFU
- ✅ **Progress Tracking** — real-time byte counters and ETA for large databases
- ✅ **Backup Cancellation** — graceful abort of in-flight operations

### Server Management

- ✅ **Docker Compose VPS** — auto-detect running containers and services
- ✅ **External URI Targets** — Direct Postgres/MongoDB URI connections (no SSH required)
- ✅ **SSH Credential Caching** — passphrases cached in memory, cleared on app exit
- ✅ **Known Hosts Management** — Trust-on-first-use (TOFU) with manual host revocation
- ✅ **Connection Testing** — Pre-flight validation before backup/restore operations

### Restore Operations

- ✅ **Selective Database Restore** — Choose target server and database name
- ✅ **Restore State Tracking** — History of all restore operations for audit compliance
- ✅ **VPS Restoration** — restore via Docker Compose service or external URI
- ✅ **Abort on Error** — Graceful handling of network interruptions and permission failures

### Data Integrity

- ✅ **Encrypted Storage** — AES-256-GCM encryption for all backups
- ✅ **Keychain Integration** — OS-level key management (macOS Keychain, Windows Credential Manager, Linux SecretService)
- ✅ **Checksum Validation** — SHA-512 verification during restore operations
- ✅ **Database Viewer** — Read-only inspection of MongoDB backup contents

### Audit & Compliance

- ✅ **Immutable Audit Log** — all operations logged with timestamps and operators
- ✅ **Dump List** — complete backup inventory with file sizes and metadata
- ✅ **Migration Tracking** — automatic schema version tracking for backward compatibility
- ✅ **Privacy Acceptance** — Explicit consent flow for telemetry (disabled by default)

### Developer Features

- ✅ **Hot Reload** — Development mode with automatic IPC reloading
- ✅ **Unit Tests** — Test suite for crypto, database operations, and migrations
- ✅ **Automated Release Builds** — CI/CD integration via Codemagic for multi-platform builds
- ✅ **Auto-Update** — Built-in update checking via `electron-updater`

---

## Technical Architecture

### Application Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Main (IPC Server)               │
├─────────────────────────────────────────────────────────────┤
│  • App Lifecycle & Window Management                         │
│  • IPC Router (backup, restore, discovery, audit)            │
│  • Credential Management (Keychain, SSH passphrases)         │
│  • Storage Layer (Dumps, Profiles, Servers, Targets)         │
└──────┬────────────────────────────┬──────────────────────────┘
       │                            │
       │ IPC                        │ Local Storage
       │                            │ (JSON + Audit Log)
       ▼                            ▼
┌──────────────────────┐   ┌──────────────────┐
│  React Renderer UI   │   │  ~/.tunnex/      │
│  (Next.js style)     │   │  ├─ servers.json │
│  • Dashboard         │   │  ├─ targets.json │
│  • Backup Queue      │   │  ├─ dumps/       │
│  │  Restore Modal    │   │  ├─ audit.log    │
│  └─ DB Viewer        │   │  └─ ..           │
└──────────────────────┘   └──────────────────┘
```

### Data Flow: Backup Pipeline

```
Electron Main (IPC Handler)
  │
  ├─> Load Server Config (SSH credentials)
  ├─> Load Target Config (DB connection string)
  ├─> Open SSH/Local Channel → Remote Host
  │   │
  │   └─> Detect Docker Service || Direct DB Connection
  │
  ├─> Fetch Encryption Key from Keychain
  ├─> Spawn DB Dump Process (pg_dump / mongodump)
  │
  ├─> Streaming Encryption (AES-256-GCM)
  │   stdin ──> EncryptStream ──> FileSystem
  │   (no disk temp files)
  │
  ├─> Track Size & Progress → Renderer UI
  └─> Log Operation → Audit Trail
```

### Execution Channels

Three transport layers for remote execution:

1. **SSH (Primary)** — docker-compose VPS with SSH access
   - Public key authentication
   - Passphrase caching in memory
   - Automatic `sudo` elevation if needed for Docker socket

2. **Docker Socket (Local)** — localhost Docker daemon
   - Direct socket connection
   - Used for backup/restore to containerized services running locally

3. **External URI (Direct)** — PostgreSQL/MongoDB on external IPs/domains
   - No SSH required
   - Direct TCP connection over network

### Encryption Pipeline

```
Database Output Stream
  │
  └─> EncryptStream (AES-256-GCM)
      │
      ├─ IV (12 bytes, random)
      ├─ Ciphertext (variable)
      └─ Auth Tag (16 bytes)
  │
  └─> FileSystem (encrypted-dump.bin)
```

- **Key Storage:** macOS Keychain, Windows Credential Manager, Linux SecretService
- **Key Derivation:** One unique random key per backup (stored encrypted in keychain)
- **Integrity:** GCM mode provides authenticated encryption (detects tampering)

---

## Technology Stack

### Core Framework

| Layer        | Technology          | Purpose                               |
| ------------ | ------------------- | ------------------------------------- |
| **Desktop**  | Electron 33.x       | Cross-platform application shell      |
| **Backend**  | Node.js 18+         | IPC server, crypto, SSH/DB operations |
| **Frontend** | React (via Preload) | UI rendering, real-time backup status |
| **Styling**  | CSS                 | Modern, responsive interface          |

### Key Dependencies

| Package            | Version | Purpose                           |
| ------------------ | ------- | --------------------------------- |
| `ssh2`             | 1.16.0  | SSH client with tunneling support |
| `electron-updater` | 6.3.9   | Delta-based app updates           |
| `aws-sdk/s3`       | 3.713.0 | Release bucket storage (CI/CD)    |

### Build & Packaging

| Tool                    | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| `electron-builder`      | Multi-platform binary packaging (dmg, exe, deb, rpm) |
| `codemagic.yaml`        | CI/CD orchestration for automated builds             |
| `electron-icon-builder` | Icon conversion (PNG → ICNS, ICO)                    |

### Storage Layer

```
~/.tunnex/
├── servers.json        (encrypted connection profiles)
├── targets.json        (DB connection details)
├── settings.json       (UI preferences)
├── audit.log          (immutable operation log)
└── dumps/
    ├── backup_2024_01_15_prod_db.bin  (encrypted backup)
    └── metadata.json
```

- All configuration files use **Electron `safeStorage`** for sensitive fields
- Dumps directory checked for disk space before backup
- Audit log rotates at 50MB with archival

---

## Prerequisites

### Minimum Requirements

- **OS:** Windows 10+, macOS 10.15+, Linux (Ubuntu 18.04+, Fedora 30+, Debian 10+)
- **RAM:** 512 MB
- **Disk:** 500 MB (for app + cache)

### For Backup Operations (Target Servers)

- **SSH Access** (port 22) to VPS with database containers, OR
- **Direct Network Access** (port 5432 for Postgres, 27017 for MongoDB)
- **PostgreSQL 10+** or **MongoDB 3.6+** running in Docker or standalone
- **Docker Compose** (if using docker-compose-vps targets)

### For Development

- **Node.js:** 18.x or later
- **npm:** 8.x or later
- **Electron Build Tools** (auto-installed via npm)
- **Python:** 3.7+ (required by `node-gyp` for `ssh2` native modules)

---

## Installation

### From Binary Release

1. Download the latest release for your platform from the [Releases](https://github.com/md-786910/dump-manager/releases) page:
   - **Windows:** `Tunnex-Setup-0.1.8.exe`
   - **macOS:** `Tunnex-0.1.8.dmg` (Intel) or Apple Silicon build
   - **Linux:** `tunnex-0.1.8-x86_64.AppImage`

2. Install and run:
   - **Windows:** Double-click the installer
   - **macOS:** Drag `Tunnex.app` to Applications folder
   - **Linux:** `chmod +x tunnex-*.AppImage && ./tunnex-*.AppImage`

3. Launch the application and accept privacy notice

### From Source

```bash
# Clone repository
git clone https://github.com/md-786910/dump-manager.git
cd dump-manager

# Install dependencies
npm install

# Start development mode
npm start

# or run with dev tools
npm run dev
```

---

## Development

### Project Structure

```
src/
├── main/              # Electron main process (backend)
│   ├── index.js       # App lifecycle, IPC registration
│   ├── logging.js     # Structured logging
│   ├── updater.js     # Auto-update handler
│   │
│   ├── crypto/        # Encryption utilities
│   │   ├── keychain.js   # OS-level key storage
│   │   └── stream.js     # AES-256-GCM encryption stream
│   │
│   ├── db/            # Database abstractions
│   │   ├── postgres.js   # PostgreSQL dump/restore
│   │   └── mongo.js      # MongoDB dump/restore
│   │
│   ├── exec/          # Remote execution
│   │   ├── channel.js    # SSH/local exec abstraction
│   │   ├── dockerSudo.js # Docker socket & sudo
│   │   └── runCommand.js # Command spawn wrapper
│   │
│   ├── ops/           # Business logic
│   │   ├── backupVps.js  # Backup orchestration
│   │   ├── restoreVps.js # Restore orchestration
│   │   ├── discovery.js  # Server introspection
│   │   └─ dbViewer.js    # MongoDB query runner
│   │
│   ├── ipc/           # IPC handlers (public API)
│   │   ├── backup.js
│   │   ├── restore.js
│   │   ├── discovery.js
│   │   ├── dialog.js
│   │   └── ...
│   │
│   ├── ssh/           # SSH client & credential management
│   │   ├── client.js
│   │   ├── knownHosts.js
│   │   └── passphraseCache.js
│   │
│   └── storage/       # Local persisted data
│       ├── servers.js
│       ├── targets.js
│       ├── dumps.js
│       ├── audit.js
│       └── migrate.js
│
├── preload/           # Preload script (IPC bridge)
│   └── index.js
│
└── renderer/          # Frontend React app
    ├── index.html
    ├── app.js
    ├── styles.css
    └── dev-mock.js    # Mock IPC for frontend-only dev
```

### Development Commands

```bash
# Start app in dev mode (with dev tools)
npm run dev

# Run tests
npm test

# Package for current platform (without signing)
npm pack

# Build for all platforms
npm run build

# Build for specific platform
npm run build:linux
npm run build:mac
npm run build:win

# Website development
npm run site            # Run at http://localhost:4321
npm run site:build      # Build static site

# Run with custom env vars
TUNNEX_DEV=1 npm start
```

### Testing

```bash
# All tests
npm test

# Specific test file
node --test test/crypto-stream.test.js

# Test coverage analysis
npm test -- --coverage
```

**Test Suites:**

- `crypto-stream.test.js` — AES-256-GCM encryption & decryption
- `channel.test.js` — SSH/local command execution
- `dbViewer.test.js` — MongoDB query parsing
- `mongo.test.js` — MongoDB dump/restore logic
- `postgres.test.js` — PostgreSQL dump/restore logic
- `migrate.test.js` — Migration script validation
- `settings.test.js` — Settings storage layer

### Hot Reload During Development

For rapid iteration on the UI, use the development mode with console logging:

```bash
npm run dev:web    # Start separate dev server on :8080
npm run dev        # App loads from dev server instead of file://
```

The development server supports hot module reloading for instant feedback.

---

## Building

### For End Users (Automatic)

Releases are built automatically via **Codemagic CI/CD** on every git tag:

```bash
git tag v0.1.8
git push origin v0.1.8
# Codemagic triggers → builds Windows/macOS/Linux → signs → uploads to releases
```

### Manual Build Process

#### Prerequisites

```bash
npm install
# Ensure you have build icons
# See build/README.md for icon setup
```

#### Build for Current Platform

```bash
# Creates installer in dist/ directory
npm run build
```

#### Build for All Platforms

```bash
npm run build      # Builds all (requires proper build environment)
npm run build:linux
npm run build:mac
npm run build:win
```

#### Build Configuration

See [electron-builder.yml](./electron-builder.yml) for platform-specific settings:

- App ID, file associations, installer options
- Code signing certificates (macOS, Windows)
- DEB/RPM metadata for Linux distributions

### Code Signing & Notarization

For production releases, the build process handles:

- **Windows:** Authenticode signing (requires code-signing certificate)
- **macOS:** Code signing + App Notarization (required for Gatekeeper)
- **Linux:** Unsigned AppImage (user verification via SHA-512)

---

## Release Notes

### v0.1.8 (Latest)

- Core backup/restore functionality for Postgres & MongoDB
- SSH tunneling and external URI support
- AES-256-GCM encryption for all backups
- Database viewer for MongoDB backups
- Audit logging and compliance trail
- Cross-platform builds (Windows, macOS, Linux)
- Auto-update support

---

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes and add tests
4. Run `npm test` to verify
5. Commit with clear messages
6. Push and create a Pull Request

### Code Style

- Use `'use strict'` at the top of files
- ESLint config (TBD — contributions welcome!)
- Test all new features with unit tests
- Document complex algorithms with inline comments

---

## Security Considerations

### Threat Model

Tunnex protects against:

- ✅ Disk plaintext exposure (encrypted storage)
- ✅ Network eavesdropping (SSH + encrypted channel)
- ✅ Credential exposure in logs (never logged)
- ✅ Unauthorized access to backups (AES-256-GCM)
- ✅ Man-in-the-middle SSH attacks (known hosts TOFU)

### Known Limitations

- ⚠️ Passphrases cached in memory during app lifetime (cleared on exit)
- ⚠️ Requires SSH access or network connectivity to target databases
- ⚠️ Does not support database-level incremental backups (full backup per dump)

### Reporting Security Issues

For security vulnerabilities, please email security@tunnex.biz (or contact maintainers privately). Do not file public issues for security bugs.

---

## License

Proprietary — All Rights Reserved.

---

## Support

- **Documentation:** In-app help and tooltips
- **Website:** https://tunnex.biz
- **Issues:** GitHub Issues tracker
- **Email:** support@tunnex.biz (when available)

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) (when created) for detailed version history.

## Acknowledgments

Built with [Electron](https://www.electronjs.org/), [SSH2](https://github.com/mscdex/ssh2), and ❤️ by Tunnex contributors.
