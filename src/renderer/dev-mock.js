'use strict';

// Browser dev shim. Stands in for the Electron preload bridge so the UI can
// be developed in a regular browser. NO-OP when window.dbm already exists
// (i.e. running in Electron with the real bridge).
//
// Safe to include in production: the early return below makes this file
// effectively a few bytes of dead code at runtime.

(function () {
  if (window.dbm) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => new Date().toISOString();
  const clone = (v) => JSON.parse(JSON.stringify(v));

  let servers = [
    {
      id: 's-vps', name: 'vmi3269642', host: 'vmi3269642.contaboserver.net',
      port: 22, user: 'root', privateKeyPath: '/home/you/.ssh/id_ed25519',
      sudoForDocker: false, composeBin: 'docker compose', notes: null,
      createdAt: '2026-04-01T10:00:00Z', updatedAt: '2026-04-01T10:00:00Z',
    },
  ];

  let targets = [
    {
      id: 't-intranet', serverId: 's-vps', name: 'intranet — main',
      envTag: 'prod', engine: 'postgres', kind: 'docker-compose-vps',
      dbName: 'intranet_main',
      createdAt: '2026-04-01T10:00:00Z', updatedAt: '2026-04-01T10:00:00Z',
      vps: { composeProjectPath: '/root/intranet', projectName: 'intranet', service: 'db', pgUser: 'postgres' },
    },
    {
      id: 't-uptime', serverId: 's-vps', name: 'leanportuptime — db',
      envTag: 'staging', engine: 'postgres', kind: 'docker-compose-vps',
      dbName: 'uptime',
      createdAt: '2026-04-01T10:00:00Z', updatedAt: '2026-04-01T10:00:00Z',
      vps: { composeProjectPath: '/root/leanportuptime', projectName: 'leanportuptime', service: 'db', pgUser: 'postgres' },
    },
  ];

  let dumps = [
    {
      sourceProfileId: 't-intranet', sourceProfileName: 'intranet — main', envTag: 'prod',
      engine: 'postgres', format: 'pg_custom', dbName: 'intranet_main',
      byteSize: 412 * 1024 * 1024,
      createdAt: '2026-05-13T14:22:00Z', finishedAt: '2026-05-13T14:24:11Z',
      durationMs: 131_000,
      sha256Ciphertext: 'a1b2c3d4e5f607182930abcd1122334455667788991122aabbccddeeff001122',
      path: '/mock/intranet-main__intranet_main__2026-05-13T14-22-00Z.pgdump.enc',
    },
  ];

  let audit = [
    { ts: '2026-05-13T14:24:11Z', op: 'backup', serverId: 's-vps', serverName: 'vmi3269642',
      profileId: 't-intranet', profileName: 'intranet — main', dbName: 'intranet_main',
      ok: true, durationMs: 131_000, bytesOut: 412 * 1024 * 1024 },
  ];

  const connected = new Set();
  const mockBackupOps = new Map(); // opId -> { cancelled }

  const listeners = new Map();

  // ---------- mock log bus ----------
  const logBuffer = [
    { id: 'l1', ts: new Date(Date.now() - 5 * 60_000).toISOString(), level: 'info', component: 'app', message: 'Tunnex started', details: { platform: 'web' } },
    { id: 'l2', ts: new Date(Date.now() - 4 * 60_000).toISOString(), level: 'info', component: 'connection', message: 'Connected to vmi3269642', details: { host: 'vmi3269642.contaboserver.net' } },
    { id: 'l3', ts: new Date(Date.now() - 3 * 60_000).toISOString(), level: 'warn', component: 'compose', message: 'docker-compose v1 fallback', details: { reason: 'docker compose version returned non-zero' } },
    { id: 'l4', ts: new Date(Date.now() - 2 * 60_000).toISOString(), level: 'error', component: 'backup', message: 'Backup failed: pg_dump exited with code 1', details: { stderr: 'connection to server failed: timeout' } },
  ];
  let logSeq = 100;
  function mkEntry(level, component, message, details) {
    return {
      id: 'm-' + (logSeq++).toString(36),
      ts: new Date().toISOString(),
      level, component, message, details: details || null,
    };
  }
  function pushLog(level, component, message, details) {
    const entry = mkEntry(level, component, message, details);
    logBuffer.push(entry);
    emit('log:event', entry);
    return entry;
  }
  function emit(channel, payload) {
    const set = listeners.get(channel);
    if (set) for (const fn of set) try { fn(payload); } catch (e) { console.error(e); }
  }
  function on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(fn);
    return () => listeners.get(channel).delete(fn);
  }

  function toPublicTarget(t) {
    const out = {
      id: t.id, name: t.name, envTag: t.envTag, engine: t.engine,
      kind: t.kind, dbName: t.dbName, serverId: t.serverId || null,
      createdAt: t.createdAt, updatedAt: t.updatedAt,
    };
    if (t.kind === 'docker-compose-vps') out.vps = clone(t.vps);
    else out.hasUri = !!t.uri;
    return out;
  }

  window.dbm = {
    ping: async () => ({
      ok: true,
      runtime: { version: '0.0.0-dev', electron: 'browser', node: 'browser', platform: 'web', packaged: false, safeStorageAvailable: false },
    }),

    servers: {
      list: async () => clone(servers),
      create: async (input) => {
        const rec = { id: 's-' + Date.now(), composeBin: null, notes: null, sudoForDocker: !!input.sudoForDocker,
          ...clone(input), createdAt: now(), updatedAt: now() };
        servers.push(rec); return clone(rec);
      },
      update: async (id, patch) => {
        const i = servers.findIndex((s) => s.id === id);
        servers[i] = { ...servers[i], ...clone(patch), id, updatedAt: now() };
        return clone(servers[i]);
      },
      remove: async (id, cascade) => {
        servers = servers.filter((s) => s.id !== id);
        if (cascade) targets = targets.filter((t) => t.serverId !== id);
      },
    },

    targets: {
      list: async () => targets.map(toPublicTarget),
      create: async (input) => {
        const rec = { id: 't-' + Date.now() + Math.random().toString(16).slice(2, 6), ...clone(input),
          createdAt: now(), updatedAt: now() };
        if (rec.kind === 'external-uri') { rec.uri = '<encrypted>'; }
        targets.push(rec); return toPublicTarget(rec);
      },
      createMany: async (inputs) => {
        const created = [];
        for (const input of inputs) {
          const rec = { id: 't-' + Date.now() + Math.random().toString(16).slice(2, 6), ...clone(input),
            createdAt: now(), updatedAt: now() };
          if (rec.kind === 'external-uri') rec.uri = '<encrypted>';
          targets.push(rec); created.push(rec);
        }
        return created.map(toPublicTarget);
      },
      update: async (id, patch) => {
        const i = targets.findIndex((t) => t.id === id);
        targets[i] = { ...targets[i], ...clone(patch), id, updatedAt: now() };
        return toPublicTarget(targets[i]);
      },
      remove: async (id) => { targets = targets.filter((t) => t.id !== id); },
      listByServer: async (serverId) => targets.filter((t) => t.serverId === serverId).map(toPublicTarget),
      existingDbsForServer: async (serverId) =>
        targets.filter((t) => t.serverId === serverId && t.kind === 'docker-compose-vps')
          .map((t) => ({
            composeProjectPath: t.vps.composeProjectPath,
            projectName: t.vps.projectName,
            service: t.vps.service,
            dbName: t.dbName,
          })),
    },

    dumps: { list: async () => clone(dumps) },
    audit: { tail: async (n) => clone(audit.slice(-n).reverse()) },
    hosts: { list: async () => [], revoke: async () => ({ ok: true }) },

    backup: {
      start: async (targetId /* , passphrase */) => {
        const t = targets.find((x) => x.id === targetId);
        if (!t) return { ok: false, error: 'target not found' };
        if (t.kind !== 'docker-compose-vps') return { ok: false, error: 'external-URI backups not in MVP' };
        const server = servers.find((s) => s.id === t.serverId);
        if (!server) return { ok: false, error: 'server missing' };

        const opId = 'op-' + Date.now();
        mockBackupOps.set(opId, { cancelled: false });
        const ctx = mockBackupOps.get(opId);
        pushLog('info', 'backup', 'Starting backup of "' + t.name + '"', { server: server.name, dbName: t.dbName });

        // Walk through the real phase sequence so the renderer can exercise its UI.
        const phases = ['connecting', 'ssh-connecting', 'authenticated', 'starting-dump', 'waiting'];
        for (const phase of phases) {
          emit('backup:progress', { opId, phase });
          await sleep(450 + Math.random() * 250);
          if (ctx.cancelled) {
            emit('backup:progress', { opId, phase: 'cancelled' });
            mockBackupOps.delete(opId);
            return { opId, ok: false, error: 'cancelled' };
          }
        }
        let bytes = 0;
        emit('backup:progress', { opId, phase: 'streaming', bytes });
        const totalChunks = 12;
        for (let i = 0; i < totalChunks; i++) {
          await sleep(220);
          if (ctx.cancelled) {
            emit('backup:progress', { opId, phase: 'cancelled' });
            mockBackupOps.delete(opId);
            return { opId, ok: false, error: 'cancelled' };
          }
          bytes += Math.floor(30 * 1024 * 1024 + Math.random() * 20 * 1024 * 1024);
          emit('backup:progress', { opId, phase: 'streaming', bytes });
        }
        const meta = {
          schemaVersion: 2, engine: 'postgres', format: 'pg_custom',
          serverId: server.id, serverName: server.name,
          sourceProfileId: t.id, sourceProfileName: t.name,
          envTag: t.envTag, dbName: t.dbName,
          byteSize: bytes,
          createdAt: now(), finishedAt: now(), durationMs: totalChunks * 220,
          sha256Ciphertext: 'mockmockmockmock' + Date.now().toString(16).padStart(16, '0') + '0000000000000000',
          path: '/mock/' + t.name.replace(/[^a-z0-9]/gi, '_') + '__' + t.dbName + '__' + now().replace(/[:.]/g, '-') + '.pgdump.enc',
        };
        dumps.unshift(meta);
        audit.push({ ts: now(), op: 'backup', serverId: server.id, serverName: server.name,
          profileId: t.id, profileName: t.name, envTag: t.envTag, dbName: t.dbName,
          ok: true, durationMs: meta.durationMs, bytesOut: bytes,
          dumpPath: meta.path, dumpSha256: meta.sha256Ciphertext });
        pushLog('info', 'backup', 'Backup completed: ' + t.name + ' (' + bytes + ' bytes)', { sha256: meta.sha256Ciphertext });
        emit('backup:progress', { opId, phase: 'done', meta });
        mockBackupOps.delete(opId);
        return { opId, ok: true, meta };
      },
      cancel: async (opId) => {
        const ctx = mockBackupOps.get(opId);
        if (!ctx) return { ok: false, error: 'no such op' };
        ctx.cancelled = true;
        return { ok: true };
      },
      queueDepth: async () => 0,
      onProgress: (l) => on('backup:progress', l),
    },

    discovery: {
      run: async (serverId /* , passphrase */) => {
        const server = servers.find((s) => s.id === serverId);
        if (!server) return { ok: false, error: 'server not found' };
        const opId = 'op-' + Date.now();
        const phases = ['connecting', 'probing-docker', 'listing-projects',
          'reading-project', 'reading-databases', 'done'];
        for (const phase of phases) {
          emit('discovery:progress', { opId, phase, message: phase === 'reading-project' ? 'intranet' : phase === 'reading-databases' ? 'intranet/db' : '' });
          await sleep(400);
        }
        const result = {
          composeBin: 'docker compose',
          composeVersion: 'v2.27.0',
          projects: [
            {
              name: 'intranet',
              composeFile: '/root/intranet/docker-compose.yml',
              composeProjectPath: '/root/intranet',
              status: 'running(3)',
              services: [{
                name: 'db', image: 'postgres:15.4', pgUser: 'postgres',
                databases: ['intranet_main', 'intranet_audit'],
              }],
            },
            {
              name: 'leanportuptime',
              composeFile: '/root/leanportuptime/docker-compose.yml',
              composeProjectPath: '/root/leanportuptime',
              status: 'running(2)',
              services: [{
                name: 'db', image: 'postgres:16.1', pgUser: 'postgres',
                databases: ['uptime'],
              }],
            },
            {
              name: 'shop',
              composeFile: '/root/shop/compose.yml',
              composeProjectPath: '/root/shop',
              status: 'running(4)',
              services: [{
                name: 'pg', image: 'postgres:14', pgUser: 'shop',
                databases: ['shop_main', 'shop_test'],
              }],
            },
          ],
        };
        return { opId, ok: true, result };
      },
      onProgress: (l) => on('discovery:progress', l),
    },

    compose: {
      listProjects: async (serverId, passphrase) => {
        await sleep(450);
        if (!servers.find((s) => s.id === serverId)) return { ok: false, error: 'server not found' };
        if (!passphrase && !connected.has(serverId)) {
          return { ok: false, error: 'passphrase required (server not connected)' };
        }
        if (passphrase) connected.add(serverId);
        return {
          ok: true,
          composeBin: 'docker compose',
          composeVersion: 'v2.27.0',
          projects: [
            {
              name: 'intranet',
              path: '/root/intranet',
              composeFile: '/root/intranet/docker-compose.yml',
              status: 'running(3)',
              services: [
                { name: 'db', image: 'postgres:15.4', isPostgres: true, isMongo: false },
                { name: 'app', image: 'myapp:latest', isPostgres: false, isMongo: false },
                { name: 'redis', image: 'redis:7', isPostgres: false, isMongo: false },
              ],
            },
            {
              name: 'leanportuptime',
              path: '/root/leanportuptime',
              composeFile: '/root/leanportuptime/docker-compose.yml',
              status: 'running(2)',
              services: [
                { name: 'db', image: 'postgres:16.1', isPostgres: true, isMongo: false },
                { name: 'worker', image: 'leanport:latest', isPostgres: false, isMongo: false },
              ],
            },
            {
              name: 'shop',
              path: '/root/shop',
              composeFile: '/root/shop/compose.yml',
              status: 'running(4)',
              services: [
                { name: 'pg', image: 'postgres:14', isPostgres: true, isMongo: false },
                { name: 'pg-replica', image: 'postgres:14', isPostgres: true, isMongo: false },
                { name: 'api', image: 'shop:latest', isPostgres: false, isMongo: false },
              ],
            },
          ],
        };
      },
    },

    connection: {
      test: async (serverId, passphrase) => {
        const s = servers.find((x) => x.id === serverId);
        await sleep(500);
        if (!passphrase && !connected.has(serverId)) {
          pushLog('warn', 'connection', 'Connect failed for ' + (s && s.name) + ': passphrase required');
          return { ok: false, error: 'passphrase required' };
        }
        connected.add(serverId);
        pushLog('info', 'connection', 'Connected to ' + (s && s.name), { serverId });
        return { ok: true };
      },
      disconnect: async (serverId) => {
        const s = servers.find((x) => x.id === serverId);
        connected.delete(serverId);
        pushLog('info', 'connection', 'Disconnected from ' + (s && s.name), { serverId });
        return { ok: true };
      },
      status: async (serverId) => ({ connected: connected.has(serverId) }),
      statusAll: async () => {
        const out = {};
        for (const s of servers) out[s.id] = connected.has(s.id);
        return out;
      },
    },

    logs: {
      tail: async (n) => clone(logBuffer.slice(-(n || 200))),
      append: async (e) => { pushLog(e.level || 'info', e.component || 'renderer', e.message, e.details); return { ok: true }; },
      onEvent: (l) => on('log:event', l),
    },

    dialog: {
      pickKeyFile: async () => {
        await sleep(120);
        const samples = ['/home/you/.ssh/id_ed25519', '/home/you/.ssh/id_rsa', '/home/you/.ssh/work.pem'];
        return samples[Math.floor(Math.random() * samples.length)];
      },
    },

    // Auto-update no-ops in the browser dev-server — nothing to install.
    updates: {
      check: async () => ({ ok: true }),
      installNow: async () => ({ ok: true }),
      on: () => () => {},
    },
  };

  document.body && document.body.setAttribute('data-dev-mock', '1');
  document.addEventListener('DOMContentLoaded', () => {
    document.body.setAttribute('data-dev-mock', '1');
  });

  console.info('[Tunnex] dev mode — using mock window.dbm. Data is in-memory only and resets on reload.');
})();
