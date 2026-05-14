'use strict';

// One-shot migration: legacy profiles.json → servers.json + targets.json.
//
// Grouping rule: profiles with the same (host, port, user, privateKeyPath)
// collapse into one Server. Each legacy profile becomes one Target referencing
// that Server. The legacy file is renamed to profiles.legacy.json so the
// next launch sees `targets.json exists` and short-circuits.
//
// A second sidecar file `legacyProfileMap.json` records old-id → new-id so the
// existing dump sidecars (which embed sourceProfileId) keep resolving.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function paths(app) {
  const dir = app.getPath('userData');
  return {
    legacyProfiles: path.join(dir, 'profiles.json'),
    legacyRenamed: path.join(dir, 'profiles.legacy.json'),
    servers: path.join(dir, 'servers.json'),
    targets: path.join(dir, 'targets.json'),
    legacyMap: path.join(dir, 'legacyProfileMap.json'),
  };
}

// Pure function so we can unit-test it. Takes the parsed legacy array, returns
// `{ servers, targets, legacyMap }`. `now` is injected so tests can pin time.
function transform(legacyProfiles, now) {
  const servers = [];
  const serversByKey = new Map(); // key → server
  const targets = [];
  const legacyMap = {}; // legacyProfileId → newTargetId

  for (const p of legacyProfiles) {
    let serverId = null;
    if (p.kind === 'docker-compose-vps' && p.vps) {
      const key = [p.vps.host, p.vps.port || 22, p.vps.user, p.vps.privateKeyPath].join('|');
      let server = serversByKey.get(key);
      if (!server) {
        server = {
          id: crypto.randomUUID(),
          name: p.vps.host,
          host: p.vps.host,
          port: Number(p.vps.port) || 22,
          user: p.vps.user,
          privateKeyPath: p.vps.privateKeyPath,
          sudoForDocker: false,
          composeBin: null,
          notes: null,
          createdAt: now,
          updatedAt: now,
        };
        servers.push(server);
        serversByKey.set(key, server);
      }
      serverId = server.id;
    }

    const target = {
      id: crypto.randomUUID(),
      name: p.name,
      envTag: p.envTag,
      engine: p.engine,
      kind: p.kind,
      dbName: p.dbName,
      createdAt: p.createdAt || now,
      updatedAt: now,
    };
    if (p.kind === 'docker-compose-vps') {
      target.serverId = serverId;
      target.vps = {
        composeProjectPath: p.vps.composeProjectPath || null,
        projectName: null,
        service: p.vps.service,
        pgUser: p.vps.pgUser || null,
      };
    } else if (p.kind === 'external-uri') {
      // Sensitive `uri` is already wrapped via safeStorage; copy the wrapped
      // blob as-is — no decryption needed, the new schema uses the same shape.
      target.uri = p.uri || null;
    }
    targets.push(target);
    legacyMap[p.id] = target.id;
  }

  return { servers, targets, legacyMap };
}

function run(app) {
  const P = paths(app);

  // Already migrated? Bail.
  if (fs.existsSync(P.targets)) return { migrated: false, reason: 'targets.json exists' };

  // Nothing to migrate? First-run with empty data — write empty stores.
  if (!fs.existsSync(P.legacyProfiles)) {
    write(P.servers, []);
    write(P.targets, []);
    return { migrated: false, reason: 'no legacy data' };
  }

  const raw = fs.readFileSync(P.legacyProfiles, 'utf8').trim();
  const legacy = raw ? JSON.parse(raw) : [];
  const now = new Date().toISOString();
  const { servers, targets, legacyMap } = transform(legacy, now);

  write(P.servers, servers);
  write(P.targets, targets);
  fs.writeFileSync(P.legacyMap, JSON.stringify(legacyMap, null, 2), { mode: 0o600 });
  fs.renameSync(P.legacyProfiles, P.legacyRenamed);

  return {
    migrated: true,
    serverCount: servers.length,
    targetCount: targets.length,
  };
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

module.exports = { run, transform, paths };
