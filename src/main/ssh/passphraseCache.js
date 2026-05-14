'use strict';

// In-memory passphrase cache, keyed by Server.id.
//
// - Entries hold the passphrase as a Buffer plus a "lastUsed" timestamp.
// - Each call to `get` refreshes lastUsed.
// - A sweeper runs every 30s; entries older than IDLE_MS get zeroed and dropped.
// - On app `before-quit`, the entire cache is cleared and Buffers zeroed.
//
// Never persisted. Never logged. Returned only to main-process code that is
// about to feed the value into `ssh2.connect`.

const IDLE_MS = 15 * 60 * 1000;
const SWEEP_MS = 30 * 1000;

const entries = new Map(); // serverId -> { buf, lastUsed }
let sweeper = null;

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, e] of entries) {
      if (now - e.lastUsed > IDLE_MS) {
        zeroAndDrop(id);
      }
    }
  }, SWEEP_MS);
  // Don't keep the event loop alive just for the sweeper.
  if (sweeper.unref) sweeper.unref();
}

function zeroAndDrop(id) {
  const e = entries.get(id);
  if (!e) return;
  try { e.buf.fill(0); } catch { /* ignore */ }
  entries.delete(id);
}

function set(serverId, passphraseString) {
  if (!serverId) return;
  // Drop and zero any previous value before overwriting.
  zeroAndDrop(serverId);
  if (!passphraseString) return; // empty passphrase = don't cache
  const buf = Buffer.from(passphraseString, 'utf8');
  entries.set(serverId, { buf, lastUsed: Date.now() });
  startSweeper();
}

function get(serverId) {
  const e = entries.get(serverId);
  if (!e) return null;
  e.lastUsed = Date.now();
  return e.buf.toString('utf8');
}

function has(serverId) { return entries.has(serverId); }

function clearAll() {
  for (const id of Array.from(entries.keys())) zeroAndDrop(id);
  if (sweeper) { clearInterval(sweeper); sweeper = null; }
}

// Hook into the Electron app lifecycle so quitting always zeros the cache.
function attach(app) {
  app.on('before-quit', clearAll);
}

function drop(serverId) { zeroAndDrop(serverId); }

module.exports = { set, get, has, drop, clearAll, attach, IDLE_MS };
