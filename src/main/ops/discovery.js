'use strict';

// Discovery: introspect a VPS to find compose projects, their Postgres
// services, and the databases inside each.
//
// Flow:
//   1. Open SSH.
//   2. Probe the docker compose dialect (v2 → v1 fallback); cache on Server.
//   3. `<dc> ls --format json` — running projects.
//   4. For each project: `<dc> -p <name> config --format json` — services.
//   5. For each Postgres service: detect POSTGRES_USER, list databases.
//
// Returns a structured tree the renderer can render directly. All commands
// route through `pg.shQuote` for safety. `sudoForDocker` is honored.

const channel = require('../exec/channel');
const runCommand = require('../exec/runCommand');
const pg = require('../db/postgres');
const mg = require('../db/mongo');

async function probeComposeBin(ch, { sudo }) {
  // Try v2.
  const v2 = await runCommand(ch, (sudo ? 'sudo ' : '') + 'docker compose version --short 2>/dev/null');
  if (v2.exitCode === 0 && v2.stdout.trim()) {
    return { composeBin: 'docker compose', version: v2.stdout.trim() };
  }
  // Try v1.
  const v1 = await runCommand(ch, (sudo ? 'sudo ' : '') + 'docker-compose --version 2>/dev/null');
  if (v1.exitCode === 0 && v1.stdout.trim()) {
    return { composeBin: 'docker-compose', version: v1.stdout.trim() };
  }
  throw new Error(
    'No docker compose found (tried `docker compose version` and `docker-compose --version`).' +
    (sudo ? '' : ' If docker requires sudo here, enable the sudo toggle on the Server.')
  );
}

// `opts`:
//   server         — Server record
//   privateKey     — Buffer
//   passphrase     — string | undefined
//   knownHosts     — known-hosts API
//   onProgress     — optional ({ phase, message? }) for the UI
//   onUntrustedHost — TOFU prompt
async function run(opts) {
  const { server, privateKey, passphrase, knownHosts, onProgress, onUntrustedHost } = opts;
  const emit = (phase, message) => { if (onProgress) onProgress({ phase, message }); };

  emit('connecting');
  const ch = await channel.connect(server, {
    privateKey, passphrase, knownHosts, onUntrustedHost,
  });

  try {
    emit('probing-docker');
    const sudo = !!server.sudoForDocker;
    const dialect = await probeComposeBin(ch, { sudo });

    emit('listing-projects');
    const lsCmd = pg.composeListCommand({ composeBin: dialect.composeBin, sudo });
    const ls = await runCommand(ch, lsCmd);
    if (ls.exitCode !== 0) {
      throw new Error('docker compose ls failed: ' + (ls.stderr || 'no output').trim());
    }
    let lsRows;
    try { lsRows = pg.parseComposeLs(ls.stdout); }
    catch (e) { throw new Error('could not parse compose ls output: ' + e.message); }

    const projects = [];
    for (const row of lsRows) {
      emit('reading-project', row.name);
      const composeFile = row.configFiles[0] || null;
      // `cd <dir>` works whether compose-bin uses cwd or -p; for safety we
      // both cd and pass -p so it doesn't matter how compose resolves the project.
      const composeProjectPath = composeFile ? composeFile.replace(/\/[^/]+$/, '') : null;

      const cfgCmd = pg.composeConfigServicesCommand({
        composeBin: dialect.composeBin, sudo, projectName: row.name, composeProjectPath,
      });
      const cfg = await runCommand(ch, cfgCmd);
      if (cfg.exitCode !== 0) {
        // Skip with a note rather than abort the whole discovery — one bad
        // project shouldn't ruin the others.
        projects.push({ name: row.name, composeFile, composeProjectPath, error: cfg.stderr.trim() || 'config failed' });
        continue;
      }

      let services;
      try { services = pg.parseComposeConfig(cfg.stdout); }
      catch (e) {
        projects.push({ name: row.name, composeFile, composeProjectPath, error: 'parse error: ' + e.message });
        continue;
      }

      const discoveredServices = [];
      for (const svc of services) {
        const isPostgres = pg.isPostgresImage(svc.image);
        const isMongo = pg.isMongoImage(svc.image);
        if (!isPostgres && !isMongo) continue;

        emit('reading-databases', row.name + '/' + svc.name);

        if (isPostgres) {
          // Discover the Postgres superuser (env var inside container).
          const envCmd = pg.printenvCommand({
            composeBin: dialect.composeBin, sudo, projectName: row.name, composeProjectPath,
            service: svc.name, varName: 'POSTGRES_USER',
          });
          const envRes = await runCommand(ch, envCmd);
          const pgUser = (envRes.stdout || '').trim() || 'postgres';

          // List databases.
          const psqlCmd = pg.psqlListDbsCommand({
            composeBin: dialect.composeBin, sudo, projectName: row.name, composeProjectPath,
            service: svc.name, pgUser,
          });
          const psql = await runCommand(ch, psqlCmd);
          let databases = [];
          let svcError = null;
          if (psql.exitCode === 0) {
            databases = pg.parsePsqlDbList(psql.stdout);
          } else {
            svcError = (psql.stderr || 'psql failed').trim();
          }

          discoveredServices.push({
            name: svc.name, image: svc.image, engine: 'postgres',
            pgUser, databases, error: svcError,
          });
        } else {
          // MongoDB service — probe shell, then list databases.
          const probeCmd = mg.mongoShellProbeCommand({
            composeBin: dialect.composeBin, sudo, projectName: row.name, composeProjectPath,
            service: svc.name,
          });
          const probeRes = await runCommand(ch, probeCmd);
          const shell = (probeRes.stdout || '').trim() === 'mongosh' ? 'mongosh' : 'mongo';

          const listCmd = mg.mongoListDbsCommand({
            composeBin: dialect.composeBin, sudo, projectName: row.name, composeProjectPath,
            service: svc.name, shell,
          });
          const listRes = await runCommand(ch, listCmd);
          let databases = [];
          let svcError = null;
          if (listRes.exitCode === 0) {
            try { databases = mg.parseMongoDbs(listRes.stdout); }
            catch { svcError = 'failed to parse db list'; }
          } else {
            svcError = (listRes.stderr || 'mongosh failed').trim();
          }

          discoveredServices.push({
            name: svc.name, image: svc.image, engine: 'mongo',
            mongoShell: shell, databases, error: svcError,
          });
        }
      }

      projects.push({
        name: row.name,
        composeFile,
        composeProjectPath,
        status: row.status,
        services: discoveredServices,
      });
    }

    emit('done');
    return {
      composeBin: dialect.composeBin,
      composeVersion: dialect.version,
      projects,
    };
  } finally {
    try { ch.end(); } catch {}
  }
}

// A lighter variant of `run` for the target editor: lists compose projects and
// their services, without the per-DB `psql -lqt` round-trip. Fast enough to
// fire on every Target-modal open.
async function listProjects({ server, privateKey, passphrase, knownHosts, onUntrustedHost }) {
  const ch = await channel.connect(server, {
    privateKey, passphrase, knownHosts, onUntrustedHost,
  });

  try {
    const sudo = !!server.sudoForDocker;
    const dialect = await probeComposeBin(ch, { sudo });

    const lsCmd = pg.composeListCommand({ composeBin: dialect.composeBin, sudo });
    const ls = await runCommand(ch, lsCmd);
    if (ls.exitCode !== 0) {
      throw new Error('docker compose ls failed: ' + (ls.stderr || 'no output').trim());
    }
    const rows = pg.parseComposeLs(ls.stdout);

    const projects = [];
    for (const row of rows) {
      const composeFile = row.configFiles[0] || null;
      const composeProjectPath = composeFile ? composeFile.replace(/\/[^/]+$/, '') : null;

      const cfgCmd = pg.composeConfigServicesCommand({
        composeBin: dialect.composeBin, sudo, projectName: row.name, composeProjectPath,
      });
      const cfg = await runCommand(ch, cfgCmd);

      let services = [];
      if (cfg.exitCode === 0) {
        try {
          const parsed = pg.parseComposeConfig(cfg.stdout);
          services = parsed.map((s) => ({
            name: s.name,
            image: s.image,
            isPostgres: pg.isPostgresImage(s.image),
            isMongo: pg.isMongoImage(s.image),
          }));
        } catch { /* parse failures ignored — project still listed with empty services */ }
      }

      projects.push({
        name: row.name,
        path: composeProjectPath,
        composeFile,
        status: row.status,
        services,
      });
    }

    return {
      composeBin: dialect.composeBin,
      composeVersion: dialect.version,
      projects,
    };
  } finally {
    try { ch.end(); } catch {}
  }
}

module.exports = { run, listProjects, _runCommand: runCommand };
