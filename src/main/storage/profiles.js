'use strict';

// Connection profiles stored at <userData>/profiles.json.
//
// Sensitive string fields (currently: external URIs) are wrapped as
// `{ enc: "<base64 safeStorage output>" }`. Non-secret targeting info
// (host, port, user, key path) stays as plain JSON for readability — the
// private key file itself is what protects access, and is never copied here.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'profiles.json';

function filePath(app) { return path.join(app.getPath('userData'), FILE_NAME); }

function readAll(app) {
  const file = filePath(app);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return [];
  return JSON.parse(raw);
}

function writeAll(app, profiles) {
  const file = filePath(app);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(profiles, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function enc(safeStorage, value) {
  if (value == null || value === '') return null;
  return { enc: safeStorage.encryptString(value).toString('base64') };
}
function dec(safeStorage, wrapped) {
  if (!wrapped || !wrapped.enc) return null;
  return safeStorage.decryptString(Buffer.from(wrapped.enc, 'base64'));
}

const ENV_TAGS = new Set(['dev', 'staging', 'prod']);
const ENGINES = new Set(['postgres', 'mongo']);
const KINDS = new Set(['docker-compose-vps', 'external-uri']);

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('profile required');
  if (!input.name || typeof input.name !== 'string') throw new Error('name required');
  if (!ENV_TAGS.has(input.envTag)) throw new Error('envTag must be dev|staging|prod');
  if (!ENGINES.has(input.engine)) throw new Error('engine must be postgres|mongo');
  if (!KINDS.has(input.kind)) throw new Error('kind must be docker-compose-vps|external-uri');
  if (!input.dbName || typeof input.dbName !== 'string') throw new Error('dbName required');

  if (input.kind === 'docker-compose-vps') {
    const v = input.vps || {};
    if (!v.host) throw new Error('vps.host required');
    if (!v.user) throw new Error('vps.user required');
    if (!v.privateKeyPath) throw new Error('vps.privateKeyPath required');
    if (!v.service) throw new Error('vps.service required');
  } else {
    if (!input.uri) throw new Error('uri required for external-uri profile');
  }
}

// Public-shape profile (sensitive fields elided/marked as present).
function toPublic(p) {
  const out = {
    id: p.id,
    name: p.name,
    envTag: p.envTag,
    engine: p.engine,
    kind: p.kind,
    dbName: p.dbName,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  if (p.kind === 'docker-compose-vps') {
    out.vps = {
      host: p.vps.host,
      port: p.vps.port || 22,
      user: p.vps.user,
      privateKeyPath: p.vps.privateKeyPath,
      composeProjectPath: p.vps.composeProjectPath || null,
      service: p.vps.service,
    };
  } else {
    out.hasUri = !!p.uri;
  }
  return out;
}

function buildApi(app, safeStorage) {
  return {
    list() {
      return readAll(app).map(toPublic);
    },

    create(input) {
      validateInput(input);
      const all = readAll(app);
      const now = new Date().toISOString();
      const rec = {
        id: crypto.randomUUID(),
        name: input.name,
        envTag: input.envTag,
        engine: input.engine,
        kind: input.kind,
        dbName: input.dbName,
        createdAt: now,
        updatedAt: now,
      };
      if (input.kind === 'docker-compose-vps') {
        rec.vps = {
          host: input.vps.host,
          port: Number(input.vps.port) || 22,
          user: input.vps.user,
          privateKeyPath: input.vps.privateKeyPath,
          composeProjectPath: input.vps.composeProjectPath || null,
          service: input.vps.service,
        };
      } else {
        rec.uri = enc(safeStorage, input.uri);
      }
      all.push(rec);
      writeAll(app, all);
      return toPublic(rec);
    },

    update(id, patch) {
      const all = readAll(app);
      const idx = all.findIndex((p) => p.id === id);
      if (idx < 0) throw new Error('profile not found: ' + id);
      const merged = { ...all[idx], ...patch, id: all[idx].id, updatedAt: new Date().toISOString() };
      validateInput(merged);
      if (merged.kind === 'external-uri' && patch.uri !== undefined) {
        merged.uri = enc(safeStorage, patch.uri);
      }
      all[idx] = merged;
      writeAll(app, all);
      return toPublic(merged);
    },

    remove(id) {
      const all = readAll(app);
      const filtered = all.filter((p) => p.id !== id);
      if (filtered.length === all.length) throw new Error('profile not found: ' + id);
      writeAll(app, filtered);
    },

    // Internal — returns the raw record with sensitive fields decrypted.
    // Never returned to the renderer; only used by main-process operations.
    _getDecrypted(id) {
      const all = readAll(app);
      const rec = all.find((p) => p.id === id);
      if (!rec) throw new Error('profile not found: ' + id);
      const copy = { ...rec };
      if (rec.kind === 'external-uri') copy.uri = dec(safeStorage, rec.uri);
      return copy;
    },
  };
}

module.exports = { buildApi };
