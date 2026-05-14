'use strict';

// Dump files live in the user-configured folder (settings.dumpsDir) or, if
// unset, in <userData>/dumps. Each dump is two files: <name>.pgdump.enc plus
// a <name>.json sidecar with metadata. Listing is a directory scan of sidecars.

const fs = require('node:fs');
const path = require('node:path');

const settings = require('./settings');

function dumpDir(app) {
  const cfg = settings.get(app, 'dumpsDir');
  return cfg && typeof cfg === 'string' ? cfg : path.join(app.getPath('userData'), 'dumps');
}

function ensureDir(app) {
  const d = dumpDir(app);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function buildDumpName(profile, when) {
  const ts = when.toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z');
  const safeName = profile.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const safeDb = profile.dbName.replace(/[^A-Za-z0-9._-]+/g, '_');
  return safeName + '__' + safeDb + '__' + ts + '.pgdump.enc';
}

function sidecarPath(dumpPath) { return dumpPath + '.json'; }

function writeSidecar(dumpPath, meta) {
  fs.writeFileSync(sidecarPath(dumpPath), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

function list(app) {
  const d = dumpDir(app);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const entry of fs.readdirSync(d)) {
    if (!entry.endsWith('.pgdump.enc.json')) continue;
    const sidecar = path.join(d, entry);
    let meta;
    try { meta = JSON.parse(fs.readFileSync(sidecar, 'utf8')); }
    catch { continue; }
    const dumpFile = sidecar.slice(0, -'.json'.length);
    if (!fs.existsSync(dumpFile)) continue;
    out.push({ ...meta, path: dumpFile });
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

function remove(dumpPath) {
  if (fs.existsSync(dumpPath)) fs.unlinkSync(dumpPath);
  const sc = sidecarPath(dumpPath);
  if (fs.existsSync(sc)) fs.unlinkSync(sc);
}

// Move every <name>.pgdump.enc + sidecar from `fromDir` into `toDir`.
// Tries rename first (fast, atomic on same volume); on EXDEV (cross-device)
// falls back to copy + unlink. Returns { moved, errors }.
function migrate(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  const moved = [];
  const errors = [];
  if (!fs.existsSync(fromDir)) return { moved, errors };
  for (const entry of fs.readdirSync(fromDir)) {
    if (!entry.endsWith('.pgdump.enc') && !entry.endsWith('.pgdump.enc.json')) continue;
    const src = path.join(fromDir, entry);
    const dst = path.join(toDir, entry);
    try {
      try {
        fs.renameSync(src, dst);
      } catch (err) {
        if (err && err.code === 'EXDEV') {
          fs.copyFileSync(src, dst);
          fs.unlinkSync(src);
        } else {
          throw err;
        }
      }
      moved.push(entry);
    } catch (err) {
      errors.push({ entry, error: err.message });
    }
  }
  return { moved, errors };
}

module.exports = { dumpDir, ensureDir, buildDumpName, sidecarPath, writeSidecar, list, remove, migrate };
