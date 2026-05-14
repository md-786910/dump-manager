'use strict';

// Append-only NDJSON audit log at <userData>/audit.log.
// Schema (one JSON object per line):
//   { ts, op, profileId, profileName, dbName, ok, error?, durationMs,
//     bytesIn?, bytesOut?, dumpPath?, dumpSha256? }

const fs = require('node:fs');
const path = require('node:path');

function filePath(app) { return path.join(app.getPath('userData'), 'audit.log'); }

function append(app, entry) {
  const f = filePath(app);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(f, line, { mode: 0o600 });
}

function tail(app, n = 50) {
  const f = filePath(app);
  if (!fs.existsSync(f)) return [];
  const raw = fs.readFileSync(f, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const slice = lines.slice(-n);
  const out = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out.reverse();
}

module.exports = { append, tail, filePath };
