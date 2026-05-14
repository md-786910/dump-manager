'use strict';

// App-level preferences at <userData>/settings.json. Single JSON blob, atomic
// writes (write to .tmp + rename). Keys today:
//   dumpsDir : absolute path where dump files live (default: <userData>/dumps)
// Schema is open: future settings live alongside without migration.

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'settings.json';
function filePath(app) { return path.join(app.getPath('userData'), FILE_NAME); }

function readAll(app) {
  const f = filePath(app);
  if (!fs.existsSync(f)) return {};
  const raw = fs.readFileSync(f, 'utf8');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function writeAll(app, obj) {
  const f = filePath(app);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function get(app, key) {
  const all = readAll(app);
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : undefined;
}

function set(app, key, value) {
  const all = readAll(app);
  if (value === undefined) delete all[key];
  else all[key] = value;
  writeAll(app, all);
  return value;
}

function all(app) { return readAll(app); }

module.exports = { get, set, all, filePath };
