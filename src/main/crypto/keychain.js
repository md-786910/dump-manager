'use strict';

// Wraps a 32-byte dump key in the OS keychain via Electron `safeStorage`.
//
// Layout on disk: `<userData>/dump.key` — a base64 string produced by
// safeStorage.encryptString. The cleartext is the 32-byte key, encoded base64
// before encryption (safeStorage only handles strings).
//
// Threat model: anyone with the laptop unlocked AND the ability to run code as
// the user can decrypt. That is the same threshold as reading the user's
// browser cookies. To raise it further we would need a user-supplied passphrase
// — parked as a future option in Settings.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

let _cached = null;

function keyFilePath(app) {
  return path.join(app.getPath('userData'), 'dump.key');
}

function ensure(app) {
  if (_cached) return _cached;

  const { safeStorage } = require('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain not available — cannot store the dump encryption key safely. ' +
      'On Linux this usually means libsecret / gnome-keyring is missing.'
    );
  }

  const file = keyFilePath(app);
  if (fs.existsSync(file)) {
    const enc = fs.readFileSync(file);
    const b64 = safeStorage.decryptString(enc);
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('stored dump key is corrupt (wrong length)');
    _cached = key;
    return key;
  }

  // First run: generate and store.
  const key = crypto.randomBytes(32);
  const enc = safeStorage.encryptString(key.toString('base64'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, enc, { mode: 0o600 });
  _cached = key;
  return key;
}

function reset(app) {
  // Destructive — only callable from a Settings action with a heavy warning.
  // Existing dumps become unreadable.
  const file = keyFilePath(app);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  _cached = null;
}

module.exports = { ensure, reset, keyFilePath };
