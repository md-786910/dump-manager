'use strict';

// Streaming log bus.
//   - In-process: `subscribe(fn)` to receive every entry as it's emitted.
//   - On disk: NDJSON at <userData>/logs.ndjson, rotated at 5 MB to .1.
//   - For renderer consumption: `tail(n)` reads the most recent entries.
//
// Levels: 'debug' | 'info' | 'warn' | 'error'. The renderer filters by level.
// Components are short namespaces ('backup', 'discovery', 'connection', etc.)
// useful for grouping in the UI.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const subscribers = new Set();
let logFilePath = null;
let logFileBytes = 0;
let initialized = false;

function init(app) {
  logFilePath = path.join(app.getPath('userData'), 'logs.ndjson');
  try { logFileBytes = fs.statSync(logFilePath).size; }
  catch { logFileBytes = 0; }
  initialized = true;
}

function log(level, component, message, details) {
  const entry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level: level || 'info',
    component: component || 'app',
    message: String(message == null ? '' : message),
    details: details && typeof details === 'object' ? sanitize(details) : (details != null ? { value: details } : null),
  };
  for (const fn of subscribers) {
    try { fn(entry); } catch (err) { /* a bad subscriber must not crash the bus */ }
  }
  if (initialized && logFilePath) {
    try {
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(logFilePath, line, { mode: 0o600 });
      logFileBytes += Buffer.byteLength(line);
      if (logFileBytes > MAX_FILE_BYTES) rotate();
    } catch { /* swallow — logging must never throw */ }
  }
  return entry;
}

// Strip Buffers, functions, and circular refs so the entry is JSON-safe.
function sanitize(obj, depth = 0) {
  if (depth > 6) return '[depth-cap]';
  if (obj == null || typeof obj !== 'object') return obj;
  if (Buffer.isBuffer(obj)) return '[Buffer ' + obj.length + ' bytes]';
  if (Array.isArray(obj)) return obj.slice(0, 200).map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'function') continue;
    if (/passphrase|password|privateKey/i.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = sanitize(v, depth + 1);
  }
  return out;
}

function rotate() {
  try {
    if (fs.existsSync(logFilePath + '.1')) fs.unlinkSync(logFilePath + '.1');
    fs.renameSync(logFilePath, logFilePath + '.1');
    logFileBytes = 0;
  } catch { /* keep going even if rotate fails */ }
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function tail(n = 200) {
  if (!logFilePath || !fs.existsSync(logFilePath)) return [];
  const data = fs.readFileSync(logFilePath, 'utf8');
  const lines = data.split('\n').filter(Boolean);
  const slice = lines.slice(-n);
  const out = [];
  for (const l of slice) {
    try { out.push(JSON.parse(l)); } catch { /* skip malformed */ }
  }
  return out;
}

// Tiny convenience wrappers so call sites read cleanly.
const debug = (component, message, details) => log('debug', component, message, details);
const info  = (component, message, details) => log('info',  component, message, details);
const warn  = (component, message, details) => log('warn',  component, message, details);
const error = (component, message, details) => log('error', component, message, details);

module.exports = { init, log, subscribe, tail, debug, info, warn, error };
