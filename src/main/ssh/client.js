'use strict';

// Thin wrapper over `ssh2.Client` that enforces our host-key pinning policy
// (TOFU on first use, strict comparison after) and exposes a streaming
// `exec()` helper suited to pumping pg_dump / pg_restore data.
//
// We deliberately do NOT cache connections across operations — each backup or
// restore opens its own client and closes it on completion. The overhead is
// negligible compared to the dump itself and the simpler lifecycle is worth it.

const fs = require('node:fs');
const { Client } = require('ssh2');
const { fingerprintFromKey, detectKeyType } = require('./knownHosts');

class HostKeyMismatchError extends Error {
  constructor(host, port, expected, actual, keyType) {
    super(
      'SSH host key mismatch for ' + host + ':' + port + ' (' + keyType + ')\n' +
      '  pinned : ' + expected + '\n' +
      '  server : ' + actual + '\n' +
      'Refusing to connect. If you changed the server, revoke the pin in Settings.'
    );
    this.code = 'HOST_KEY_MISMATCH';
    this.host = host; this.port = port; this.expected = expected; this.actual = actual; this.keyType = keyType;
  }
}

class HostKeyUntrustedError extends Error {
  constructor(host, port, fingerprint, keyType) {
    super('SSH host ' + host + ':' + port + ' is not yet trusted');
    this.code = 'HOST_KEY_UNTRUSTED';
    this.host = host; this.port = port; this.fingerprint = fingerprint; this.keyType = keyType;
  }
}

// Open an SSH connection enforcing the pin policy.
//
// `opts`:
//   host, port, username
//   privateKey: Buffer
//   passphrase: string | undefined
//   knownHosts: api from ./knownHosts.js
//   onUntrustedHost?: async ({ host, port, fingerprint, keyType }) => boolean
//       If provided, called when the server presents a key not yet pinned.
//       Returning `true` pins the key and proceeds. Returning `false` aborts.
//       If absent, an untrusted host always throws HostKeyUntrustedError.
function connect(opts) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let policyResult = null; // null = pending, true = ok, Error = reject
    const emit = (phase, extra) => {
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress({ phase, ...(extra || {}) }); } catch {}
      }
    };

    client.on('ready', () => {
      if (policyResult instanceof Error) { client.end(); return reject(policyResult); }
      emit('ssh:authenticated');
      resolve(client);
    });
    // If a policy error is queued, prefer it over ssh2's generic auth-failed
    // message — otherwise the user sees "All configured authentication methods
    // failed" when the real cause was a host-key mismatch / TOFU rejection.
    client.on('error', (err) => reject(policyResult instanceof Error ? policyResult : err));
    client.on('handshake', () => emit('ssh:handshake'));

    emit('ssh:tcp-connecting');
    client.connect({
      host: opts.host,
      port: opts.port || 22,
      username: opts.username,
      privateKey: opts.privateKey,
      passphrase: opts.passphrase,
      readyTimeout: 20_000,
      // SSH-level keepalive every 15s, drop the connection after 4 unanswered
      // pings (~1 min). Without this, a NAT timeout or transient network drop
      // can leave us holding a TCP socket that will never deliver another byte
      // and never reset — which looks identical to "pg_dump is just being slow".
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      // hostHash + hostVerifier are the legacy callback. The modern way is
      // hostVerifier(key, cb) where `key` is the raw pubkey Buffer.
      hostVerifier: (key, cb) => {
        emit('ssh:host-key-check');
        try {
          const keyType = detectKeyType(key);
          const fp = fingerprintFromKey(key);
          const pinned = opts.knownHosts.lookup(opts.host, opts.port || 22);
          const pinnedFp = pinned && pinned[keyType] && pinned[keyType].fingerprint;

          if (pinnedFp) {
            if (pinnedFp === fp) { policyResult = true; return cb(true); }
            policyResult = new HostKeyMismatchError(opts.host, opts.port || 22, pinnedFp, fp, keyType);
            return cb(false);
          }

          // Not pinned yet — either TOFU-prompt via the callback or refuse.
          if (typeof opts.onUntrustedHost === 'function') {
            Promise.resolve(opts.onUntrustedHost({ host: opts.host, port: opts.port || 22, fingerprint: fp, keyType }))
              .then((trust) => {
                if (trust) {
                  opts.knownHosts.pin(opts.host, opts.port || 22, keyType, fp);
                  policyResult = true; cb(true);
                } else {
                  policyResult = new HostKeyUntrustedError(opts.host, opts.port || 22, fp, keyType);
                  cb(false);
                }
              })
              .catch((err) => { policyResult = err; cb(false); });
            return;
          }

          policyResult = new HostKeyUntrustedError(opts.host, opts.port || 22, fp, keyType);
          cb(false);
        } catch (err) {
          policyResult = err;
          cb(false);
        }
      },
    });
  });
}

function loadPrivateKey(p) {
  return fs.readFileSync(p);
}

// Execute a command, returning the raw ssh2 stream. Caller pipes stdin/stdout.
// `command` should already be safely composed by the caller — we do not
// shell-quote here.
function exec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, { pty: false }, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

module.exports = {
  connect,
  exec,
  loadPrivateKey,
  HostKeyMismatchError,
  HostKeyUntrustedError,
};
