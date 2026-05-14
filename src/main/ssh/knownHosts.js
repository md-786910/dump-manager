'use strict';

// Pinned SSH host keys, stored at <userData>/known_hosts.json.
//
// Format: { "<host>:<port>": { "<keyType>": "<sha256-base64-of-pubkey>", ... } }
//
// The fingerprint is SHA-256 of the raw server pubkey blob, base64-encoded
// without padding — same form ssh prints (e.g. `SHA256:abcd...`). We pin
// per-keytype so a server that exposes both rsa and ed25519 keeps separate
// pins (no algorithm-confusion attacks).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function filePath(app) { return path.join(app.getPath('userData'), 'known_hosts.json'); }

function readAll(app) {
  const f = filePath(app);
  if (!fs.existsSync(f)) return {};
  const raw = fs.readFileSync(f, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}

function writeAll(app, data) {
  const f = filePath(app);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function fingerprintFromKey(keyBuf) {
  // ssh2 hands us the raw SSH wire-format pubkey blob.
  const digest = crypto.createHash('sha256').update(keyBuf).digest('base64');
  return 'SHA256:' + digest.replace(/=+$/, '');
}

function detectKeyType(keyBuf) {
  // SSH key blobs start with a 4-byte big-endian length followed by the
  // algorithm name (e.g. "ssh-ed25519", "rsa-sha2-512", "ecdsa-sha2-nistp256").
  if (keyBuf.length < 4) return 'unknown';
  const len = keyBuf.readUInt32BE(0);
  if (len > keyBuf.length - 4 || len > 64) return 'unknown';
  return keyBuf.slice(4, 4 + len).toString('utf8');
}

function buildApi(app) {
  return {
    lookup(host, port) {
      const all = readAll(app);
      return all[host + ':' + port] || null;
    },

    list() {
      const all = readAll(app);
      return Object.entries(all).map(([hostPort, entry]) => ({ hostPort, ...entry }));
    },

    pin(host, port, keyType, fingerprint) {
      const all = readAll(app);
      const k = host + ':' + port;
      all[k] = all[k] || {};
      all[k][keyType] = { fingerprint, pinnedAt: new Date().toISOString() };
      writeAll(app, all);
    },

    revoke(host, port) {
      const all = readAll(app);
      delete all[host + ':' + port];
      writeAll(app, all);
    },
  };
}

module.exports = { buildApi, fingerprintFromKey, detectKeyType };
