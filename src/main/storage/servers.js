'use strict';

// Server records live at <userData>/servers.json. A Server represents the
// SSH-reachable host. It contains no secrets at rest — the private key file
// lives on the user's disk and we only store its path.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'servers.json';
function filePath(app) { return path.join(app.getPath('userData'), FILE_NAME); }

function readAll(app) {
  const f = filePath(app);
  if (!fs.existsSync(f)) return [];
  const raw = fs.readFileSync(f, 'utf8');
  return raw.trim() ? JSON.parse(raw) : [];
}

function writeAll(app, records) {
  const f = filePath(app);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

const KINDS = new Set(['ssh', 'local']);

function validate(input) {
  if (!input || typeof input !== 'object') throw new Error('server required');
  if (!input.name) throw new Error('server.name required');
  const kind = input.kind || 'ssh';
  if (!KINDS.has(kind)) throw new Error('server.kind must be ssh|local');
  if (kind === 'ssh') {
    if (!input.host) throw new Error('server.host required');
    if (!input.user) throw new Error('server.user required');
    if (!input.privateKeyPath) throw new Error('server.privateKeyPath required');
  }
  // Local servers only need a name; SSH fields are ignored.
}

function buildApi(app) {
  return {
    list() { return readAll(app); },

    get(id) {
      const all = readAll(app);
      const rec = all.find((s) => s.id === id);
      if (!rec) throw new Error('server not found: ' + id);
      return rec;
    },

    create(input) {
      validate(input);
      const all = readAll(app);
      const now = new Date().toISOString();
      const kind = input.kind || 'ssh';
      const rec = {
        id: crypto.randomUUID(),
        kind,
        name: input.name,
        host: kind === 'ssh' ? input.host : null,
        port: kind === 'ssh' ? (Number(input.port) || 22) : null,
        user: kind === 'ssh' ? input.user : null,
        privateKeyPath: kind === 'ssh' ? input.privateKeyPath : null,
        wslDistro: kind === 'local' ? (input.wslDistro || null) : null,
        sudoForDocker: !!input.sudoForDocker,
        composeBin: input.composeBin || null, // populated after discovery probes dialect
        notes: input.notes || null,
        createdAt: now,
        updatedAt: now,
      };
      all.push(rec);
      writeAll(app, all);
      return rec;
    },

    update(id, patch) {
      const all = readAll(app);
      const idx = all.findIndex((s) => s.id === id);
      if (idx < 0) throw new Error('server not found: ' + id);
      const merged = { ...all[idx], ...patch, id: all[idx].id, updatedAt: new Date().toISOString() };
      // Legacy records may lack `kind` — default to ssh for validation.
      if (!merged.kind) merged.kind = 'ssh';
      validate(merged);
      if (merged.kind === 'ssh') {
        merged.port = Number(merged.port) || 22;
        merged.wslDistro = null;
      } else if (merged.kind === 'local') {
        merged.wslDistro = merged.wslDistro || null;
      }
      merged.sudoForDocker = !!merged.sudoForDocker;
      all[idx] = merged;
      writeAll(app, all);
      return merged;
    },

    remove(id) {
      const all = readAll(app);
      const filtered = all.filter((s) => s.id !== id);
      if (filtered.length === all.length) throw new Error('server not found: ' + id);
      writeAll(app, filtered);
    },
  };
}

module.exports = { buildApi, filePath };
