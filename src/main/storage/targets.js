'use strict';

// Target records live at <userData>/targets.json. A Target is "one database we
// know how to back up", scoped to either a Server (docker-compose-vps kind) or
// to a stored URI (external-uri kind). Sensitive fields are wrapped via
// safeStorage exactly like the prior profile store.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'targets.json';
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
const KINDS = new Set(['docker-compose-vps', 'external-uri', 'installed']);

function validate(input) {
  if (!input || typeof input !== 'object') throw new Error('target required');
  if (!input.name) throw new Error('target.name required');
  if (!ENV_TAGS.has(input.envTag)) throw new Error('envTag must be dev|staging|prod');
  if (!ENGINES.has(input.engine)) throw new Error('engine must be postgres|mongo');
  if (!KINDS.has(input.kind)) throw new Error('kind must be docker-compose-vps|external-uri|installed');
  if (!input.dbName) throw new Error('target.dbName required');
  if (input.kind === 'docker-compose-vps') {
    if (!input.serverId) throw new Error('serverId required for docker-compose-vps target');
    const v = input.vps || {};
    if (!v.service) throw new Error('vps.service required');
  } else if (input.kind === 'external-uri') {
    if (!input.uri) throw new Error('uri required for external-uri target');
  } else {
    // installed — serverId optional (null = run on this machine natively)
    const ins = input.installed || {};
    if (!ins.host) throw new Error('installed.host required');
  }
}

function toPublic(t) {
  const out = {
    id: t.id,
    name: t.name,
    envTag: t.envTag,
    engine: t.engine,
    kind: t.kind,
    dbName: t.dbName,
    serverId: t.serverId || null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  if (t.kind === 'docker-compose-vps') {
    out.vps = {
      composeProjectPath: t.vps && t.vps.composeProjectPath || null,
      projectName: t.vps && t.vps.projectName || null,
      service: t.vps && t.vps.service,
      pgUser: t.vps && t.vps.pgUser || null,
      compressionLevel: t.vps && t.vps.compressionLevel != null ? t.vps.compressionLevel : null,
      mongoUser: t.vps && t.vps.mongoUser || null,
      hasMongoPassword: !!(t.vps && t.vps.mongoPassword),
      mongoAuthDb: t.vps && t.vps.mongoAuthDb || 'admin',
    };
  } else if (t.kind === 'installed') {
    out.installed = {
      host: t.installed && t.installed.host || 'localhost',
      port: t.installed && t.installed.port || null,
      dbUser: t.installed && t.installed.dbUser || null,
      hasPassword: !!(t.installed && t.installed.dbPassword),
      mongoAuthDb: t.installed && t.installed.mongoAuthDb || 'admin',
    };
  } else {
    out.hasUri = !!t.uri;
  }
  return out;
}

function _buildInstalled(safeStorage, input) {
  const ins = input.installed || {};
  return {
    host: ins.host || 'localhost',
    port: ins.port ? Number(ins.port) : null,
    dbUser: ins.dbUser || null,
    dbPassword: enc(safeStorage, ins.dbPassword || ''),
    mongoAuthDb: ins.mongoAuthDb || 'admin',
  };
}

function _buildVps(safeStorage, input) {
  const v = input.vps || {};
  const base = {
    composeProjectPath: v.composeProjectPath || null,
    projectName: v.projectName || null,
    service: v.service,
    pgUser: v.pgUser || null,
    compressionLevel: v.compressionLevel != null ? Number(v.compressionLevel) : null,
  };
  if (input.engine === 'mongo') {
    base.mongoUser = v.mongoUser || null;
    base.mongoPassword = enc(safeStorage, v.mongoPassword || '');
    base.mongoAuthDb = v.mongoAuthDb || 'admin';
  }
  return base;
}

function buildApi(app, safeStorage) {
  return {
    list() { return readAll(app).map(toPublic); },

    create(input) {
      validate(input);
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
        rec.serverId = input.serverId;
        rec.vps = _buildVps(safeStorage, input);
      } else if (input.kind === 'installed') {
        rec.serverId = input.serverId || null;
        rec.installed = _buildInstalled(safeStorage, input);
      } else {
        rec.uri = enc(safeStorage, input.uri);
      }
      all.push(rec);
      writeAll(app, all);
      return toPublic(rec);
    },

    createMany(inputs) {
      // Used by the discovery flow to bulk-create N targets at once. Validates
      // each before writing any, so a single bad input fails the whole batch.
      for (const i of inputs) validate(i);
      const all = readAll(app);
      const now = new Date().toISOString();
      const created = [];
      for (const input of inputs) {
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
          rec.serverId = input.serverId;
          rec.vps = _buildVps(safeStorage, input);
        } else if (input.kind === 'installed') {
          rec.serverId = input.serverId || null;
          rec.installed = _buildInstalled(safeStorage, input);
        } else {
          rec.uri = enc(safeStorage, input.uri);
        }
        all.push(rec);
        created.push(rec);
      }
      writeAll(app, all);
      return created.map(toPublic);
    },

    update(id, patch) {
      const all = readAll(app);
      const idx = all.findIndex((t) => t.id === id);
      if (idx < 0) throw new Error('target not found: ' + id);
      const merged = { ...all[idx], ...patch, id: all[idx].id, updatedAt: new Date().toISOString() };
      validate(merged);
      if (merged.kind === 'external-uri' && patch.uri !== undefined) {
        merged.uri = enc(safeStorage, patch.uri);
      }
      if (merged.kind === 'docker-compose-vps' && patch.vps && patch.vps.mongoPassword !== undefined) {
        merged.vps = { ...merged.vps, mongoPassword: enc(safeStorage, patch.vps.mongoPassword) };
      }
      if (merged.kind === 'installed' && patch.installed) {
        merged.installed = _buildInstalled(safeStorage, { installed: { ...merged.installed, ...patch.installed } });
      }
      all[idx] = merged;
      writeAll(app, all);
      return toPublic(merged);
    },

    remove(id) {
      const all = readAll(app);
      const filtered = all.filter((t) => t.id !== id);
      if (filtered.length === all.length) throw new Error('target not found: ' + id);
      writeAll(app, filtered);
    },

    removeManyByServer(serverId) {
      const all = readAll(app);
      const filtered = all.filter((t) => t.serverId !== serverId);
      writeAll(app, filtered);
      return all.length - filtered.length;
    },

    listByServer(serverId) {
      return readAll(app).filter((t) => t.serverId === serverId).map(toPublic);
    },

    existingDbsForServer(serverId) {
      // Used by discovery to mark already-tracked DBs.
      return readAll(app)
        .filter((t) => t.serverId === serverId && t.kind === 'docker-compose-vps')
        .map((t) => ({
          composeProjectPath: t.vps && t.vps.composeProjectPath,
          projectName: t.vps && t.vps.projectName,
          service: t.vps && t.vps.service,
          dbName: t.dbName,
        }));
    },

    // Internal — sensitive fields decrypted. Never returned over IPC.
    _getDecrypted(id) {
      const all = readAll(app);
      const rec = all.find((t) => t.id === id);
      if (!rec) throw new Error('target not found: ' + id);
      const copy = { ...rec };
      if (rec.kind === 'external-uri') copy.uri = dec(safeStorage, rec.uri);
      if (rec.kind === 'docker-compose-vps' && rec.engine === 'mongo' && rec.vps && rec.vps.mongoPassword) {
        copy.vps = { ...rec.vps, mongoPassword: dec(safeStorage, rec.vps.mongoPassword) };
      }
      if (rec.kind === 'installed' && rec.installed && rec.installed.dbPassword) {
        copy.installed = { ...rec.installed, dbPassword: dec(safeStorage, rec.installed.dbPassword) };
      }
      return copy;
    },
  };
}

module.exports = { buildApi, filePath };
