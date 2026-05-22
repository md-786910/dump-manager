'use strict';

// Plain-file restore: reads an unencrypted local backup file and streams it
// into the restore command on the target (local or remote via SSH).
// Mirrors restoreVps.js — same watchdog patterns, same progress phases —
// but skips the DecryptStream step and routes the command by fileFormat.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const channel = require('../exec/channel');
const { resolveDockerSudo } = require('../exec/dockerSudo');
const pg = require('../db/postgres');
const mg = require('../db/mongo');

// Detect backup format from file extension.
// '.sql'     → 'sql'      (plain SQL text → psql)
// '.archive' → 'archive'  (mongodump archive → mongorestore)
// anything else → 'pgdump' (pg_dump custom format → pg_restore)
function detectFileFormat(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.sql') return 'sql';
  if (ext === '.archive') return 'archive';
  return 'pgdump';
}

// `opts`:
//   server, target        — resolved records
//   filePath              — absolute path of the plain backup file
//   fileFormat            — 'sql' | 'pgdump' | 'archive' (auto-detected if omitted)
//   cleanFirst            — pass --clean --if-exists to pg_restore (ignored for .sql)
//   privateKey            — Buffer
//   passphrase            — string | undefined
//   knownHosts            — api from ssh/knownHosts.js
//   onUntrustedHost       — optional TOFU prompt callback
//   onProgress            — optional ({phase, bytes?}) => void
//   signal                — optional AbortSignal
async function run(opts) {
  const {
    server, target, filePath, cleanFirst, dbNameOverride, uri,
    privateKey, passphrase,
    knownHosts, onUntrustedHost, onProgress, signal,
  } = opts;

  const fileFormat = opts.fileFormat || detectFileFormat(filePath);

  if (!target) throw new Error('target is required');
  if (!filePath) throw new Error('filePath is required');
  if (target.kind === 'docker-compose-vps') {
    if (!server) throw new Error('server is required for docker-compose-vps target');
  } else if (target.kind === 'external-uri') {
    if (!uri) throw new Error('uri is required for external-uri target');
  } else if (target.kind === 'installed') {
    if (!target.installed || !target.installed.host) throw new Error('installed.host is required');
  } else {
    throw new Error('unsupported target.kind: ' + target.kind);
  }
  if (!fs.existsSync(filePath)) throw new Error('file not found: ' + filePath);
  const isLocal = !server || server.kind === 'local' || target.kind === 'external-uri' || target.kind === 'installed';

  const startedAt = new Date();
  const emit = (phase, extra) => { if (onProgress) try { onProgress({ phase, ...(extra || {}) }); } catch {} };

  let ch = null;
  let stream = null;
  let promiseOnErr = null;
  let aborted = false;

  const tearDownForAbort = () => {
    aborted = true;
    if (stream) {
      try { stream.signal && stream.signal('TERM'); } catch {}
      try { stream.destroy && stream.destroy(); } catch {}
    }
    if (ch) { try { ch.end(); } catch {} }
  };

  const onAbort = () => {
    tearDownForAbort();
    if (promiseOnErr) promiseOnErr(new Error('cancelled'));
  };

  if (signal) {
    if (signal.aborted) throw new Error('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
  }

  emit(isLocal ? 'local-spawning' : 'ssh-connecting');
  try {
    ch = await channel.connect(server, {
      privateKey, passphrase, knownHosts, onUntrustedHost,
      onProgress: (p) => { if (p && p.phase) emit(p.phase); },
    });
  } catch (err) {
    if (aborted) throw new Error('cancelled');
    throw err;
  }
  if (aborted) throw new Error('cancelled');
  emit('authenticated');

  const usePsql = fileFormat === 'sql';

  let command;
  let execEnv;
  if (target.kind === 'docker-compose-vps') {
    const sudo = await resolveDockerSudo(ch, server);
    if (fileFormat === 'archive') {
      command = mg.mongoRestoreCommand({
        composeBin: server.composeBin,
        sudo,
        composeProjectPath: target.vps && target.vps.composeProjectPath,
        projectName: target.vps && target.vps.projectName,
        service: target.vps.service,
        dbName: target.dbName,
        dbNameOverride,
        mongoUser: target.vps && target.vps.mongoUser,
        mongoPassword: target.vps && target.vps.mongoPassword,
        mongoAuthDb: target.vps && target.vps.mongoAuthDb,
      });
    } else if (usePsql) {
      command = pg.vpsPsqlRestoreCommand({
        composeBin: server.composeBin,
        sudo,
        composeProjectPath: target.vps && target.vps.composeProjectPath,
        projectName: target.vps && target.vps.projectName,
        service: target.vps.service,
        dbName: dbNameOverride || target.dbName,
        pgUser: target.vps && target.vps.pgUser,
      });
    } else {
      command = pg.vpsRestoreCommand({
        composeBin: server.composeBin,
        sudo,
        composeProjectPath: target.vps && target.vps.composeProjectPath,
        projectName: target.vps && target.vps.projectName,
        service: target.vps.service,
        dbName: dbNameOverride || target.dbName,
        pgUser: target.vps && target.vps.pgUser,
        cleanFirst: !!cleanFirst,
      });
    }
  } else if (target.kind === 'installed') {
    const ins = target.installed;
    const embedPassword = !!(server && server.kind === 'ssh');
    if (fileFormat === 'archive') {
      command = mg.mongoInstalledRestoreCommand({
        host: ins.host, port: ins.port, dbName: target.dbName, dbNameOverride,
        mongoUser: ins.dbUser, mongoPassword: ins.dbPassword,
        mongoAuthDb: ins.mongoAuthDb, embedPassword,
      });
      if (!embedPassword && ins.dbPassword) execEnv = { MONGO_PWD: ins.dbPassword };
    } else if (usePsql) {
      command = pg.installedPsqlRestoreCommand({
        host: ins.host, port: ins.port, dbUser: ins.dbUser, dbName: target.dbName,
        dbNameOverride, embedPassword, dbPassword: ins.dbPassword,
      });
      if (!embedPassword && ins.dbPassword) execEnv = { PGPASSWORD: ins.dbPassword };
    } else {
      command = pg.installedRestoreCommand({
        host: ins.host, port: ins.port, dbUser: ins.dbUser, dbName: target.dbName,
        dbNameOverride, cleanFirst: !!cleanFirst, embedPassword, dbPassword: ins.dbPassword,
      });
      if (!embedPassword && ins.dbPassword) execEnv = { PGPASSWORD: ins.dbPassword };
    }
  } else {
    if (fileFormat === 'archive') {
      command = mg.mongoUriRestoreCommand();
      execEnv = { MONGOURI: uri };
    } else if (usePsql) {
      command = pg.uriPsqlRestoreCommand();
      execEnv = { PGURI: uri };
    } else {
      command = pg.uriRestoreCommand({ cleanFirst: !!cleanFirst });
      execEnv = { PGURI: uri };
    }
  }

  emit('starting-restore');
  try {
    stream = await ch.exec(command, execEnv ? { env: execEnv } : undefined);
  } catch (err) {
    ch.end();
    if (aborted) throw new Error('cancelled');
    throw err;
  }
  if (aborted) throw new Error('cancelled');
  stream.resume();
  emit('waiting');

  return new Promise((resolve, reject) => {
    let bytesIn = 0;
    let stderrBuf = '';
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; fn(); };

    const sha = crypto.createHash('sha256');

    let stallTimer = null;
    const postEofTimerRef = { current: null };
    const onErr = (err) => {
      finish(() => {
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
        try { stream && stream.destroy && stream.destroy(); } catch {}
        try { ch && ch.end(); } catch {}
        reject(err);
      });
    };
    promiseOnErr = onErr;

    if (aborted) return onErr(new Error('cancelled'));

    stream.on('error', onErr);

    let stderrLineBuf = '';
    stream.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderrBuf += s;
      if (stderrBuf.length > 64 * 1024) stderrBuf = stderrBuf.slice(-32 * 1024);
      stderrLineBuf += s;
      let nl;
      while ((nl = stderrLineBuf.indexOf('\n')) !== -1) {
        const line = stderrLineBuf.slice(0, nl).replace(/\r$/, '').trim();
        stderrLineBuf = stderrLineBuf.slice(nl + 1);
        if (line) emit('stderr', { line });
      }
    });

    let streamDone = false;
    stream.on('exit', (code, sig) => {
      exitCode = code; exitSignal = sig;
      streamDone = true;
      if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
    });
    stream.on('close', () => {
      streamDone = true;
      if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
    });

    const WARN_MS = 30_000;
    const STUCK_MS = 5 * 60_000;
    const POST_EOF_MS = 30 * 60_000;
    let lastByteAt = Date.now();
    let stallWarned = false;
    stallTimer = setInterval(() => {
      const idle = Date.now() - lastByteAt;
      if (idle >= STUCK_MS) {
        clearInterval(stallTimer); stallTimer = null;
        const tool = fileFormat === 'sql' ? 'psql' : fileFormat === 'archive' ? 'mongorestore' : 'pg_restore';
        onErr(new Error('No data accepted by ' + tool + ' for ' + Math.round(idle / 1000) + 's — declaring stuck. Check the Logs drawer for stderr.'));
        return;
      }
      if (idle >= WARN_MS && !stallWarned) {
        stallWarned = true;
        emit('stalled', { idleMs: idle });
      }
    }, 5_000);

    const src = fs.createReadStream(filePath);
    const tee = new PassThrough();

    let firstChunk = true;
    tee.on('data', (chunk) => {
      if (!chunk || !chunk.length) return;
      if (stallWarned) { stallWarned = false; emit('resumed'); }
      if (firstChunk) { firstChunk = false; emit('streaming', { bytes: 0 }); }
      lastByteAt = Date.now();
      sha.update(chunk);
      bytesIn += chunk.length;
      if (onProgress) onProgress({ phase: 'streaming', bytes: bytesIn });
    });

    src.on('error', onErr);
    tee.on('error', onErr);

    // plain file → tee → remote stdin (no decryption)
    src.pipe(tee).pipe(stream.stdin);

    tee.on('end', () => {
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
      try { stream.stdin.end(); } catch {}
      emit('finalizing');
      const waitedAt = Date.now();
      const wait = () => {
        if (streamDone) {
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          if (exitCode !== 0) {
            const tool = fileFormat === 'sql' ? 'psql' : fileFormat === 'archive' ? 'mongorestore' : 'pg_restore';
            return onErr(new Error(
              tool + ' exited with code ' + exitCode +
              (exitSignal ? ' (signal ' + exitSignal + ')' : '') +
              (stderrBuf ? '\n' + stderrBuf.trim() : '')
            ));
          }
          try { ch && ch.end(); } catch {}
          const finishedAt = new Date();
          const engine = fileFormat === 'archive' ? 'mongo' : 'postgres';
          const meta = {
            schemaVersion: 1,
            op: 'restore-file',
            engine,
            fileFormat,
            serverId: server ? server.id : null,
            serverName: server ? server.name : null,
            targetId: target.id,
            targetName: target.name,
            envTag: target.envTag,
            dbName: target.dbName,
            cleanFirst: fileFormat === 'pgdump' ? !!cleanFirst : false,
            filePath,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt - startedAt,
            bytesIn,
            sha256File: sha.digest('hex'),
          };
          return finish(() => resolve({ ...meta, stderr: stderrBuf.trim() || null }));
        }
        if (Date.now() - waitedAt >= POST_EOF_MS) {
          const tool = fileFormat === 'sql' ? 'psql' : fileFormat === 'archive' ? 'mongorestore' : 'pg_restore';
          return onErr(new Error(tool + ' did not exit ' + Math.round(POST_EOF_MS / 1000) + 's after stdin closed — declaring channel hung.'));
        }
        postEofTimerRef.current = setTimeout(wait, 500);
      };
      wait();
    });
  });
}

module.exports = { run, detectFileFormat };
