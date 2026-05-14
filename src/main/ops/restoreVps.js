'use strict';

// VPS Postgres restore: opens an SSH connection to the Server, runs
// `<composeBin> exec -T <service> pg_restore -d <db>` inside the remote
// container, and streams a *decrypted* local dump straight into stdin.
//
// Mirrors backupVps.js — same watchdog patterns, same progress phases.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const channel = require('../exec/channel');
const { DecryptStream } = require('../crypto/stream');
const pg = require('../db/postgres');
const mg = require('../db/mongo');

// `opts`:
//   server, target        — resolved records
//   dumpPath              — absolute path of the .pgdump.enc file
//   cleanFirst            — pass --clean --if-exists to pg_restore
//   privateKey            — Buffer
//   passphrase            — string | undefined
//   dumpKey               — 32-byte Buffer
//   knownHosts            — api from ssh/knownHosts.js
//   onUntrustedHost       — optional TOFU prompt callback
//   onProgress            — optional ({phase, bytes?}) => void
//   signal                — optional AbortSignal
async function run(opts) {
  const {
    server, target, dumpPath, cleanFirst, dbNameOverride, uri,
    privateKey, passphrase, dumpKey,
    knownHosts, onUntrustedHost, onProgress, signal,
  } = opts;

  if (!target) throw new Error('target is required');
  if (!dumpPath) throw new Error('dumpPath is required');
  if (target.kind === 'docker-compose-vps') {
    if (!server) throw new Error('server is required for docker-compose-vps target');
  } else if (target.kind === 'external-uri') {
    if (!uri) throw new Error('uri is required for external-uri target');
  } else if (target.kind === 'installed') {
    if (!target.installed || !target.installed.host) throw new Error('installed.host is required');
  } else {
    throw new Error('unsupported target.kind: ' + target.kind);
  }
  if (!fs.existsSync(dumpPath)) throw new Error('dump file not found: ' + dumpPath);
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

  let command;
  let execEnv;
  if (target.kind === 'docker-compose-vps') {
    if (target.engine === 'mongo') {
      command = mg.mongoRestoreCommand({
        composeBin: server.composeBin,
        sudo: !!server.sudoForDocker,
        composeProjectPath: target.vps && target.vps.composeProjectPath,
        projectName: target.vps && target.vps.projectName,
        service: target.vps.service,
        dbName: target.dbName,
        dbNameOverride,
        mongoUser: target.vps && target.vps.mongoUser,
        mongoPassword: target.vps && target.vps.mongoPassword,
        mongoAuthDb: target.vps && target.vps.mongoAuthDb,
      });
    } else {
      command = pg.vpsRestoreCommand({
        composeBin: server.composeBin,
        sudo: !!server.sudoForDocker,
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
    if (target.engine === 'mongo') {
      command = mg.mongoInstalledRestoreCommand({
        host: ins.host, port: ins.port, dbName: target.dbName, dbNameOverride,
        mongoUser: ins.dbUser, mongoPassword: ins.dbPassword,
        mongoAuthDb: ins.mongoAuthDb, embedPassword,
      });
      if (!embedPassword && ins.dbPassword) execEnv = { MONGO_PWD: ins.dbPassword };
    } else {
      command = pg.installedRestoreCommand({
        host: ins.host, port: ins.port, dbUser: ins.dbUser, dbName: target.dbName,
        dbNameOverride, cleanFirst: !!cleanFirst, embedPassword, dbPassword: ins.dbPassword,
      });
      if (!embedPassword && ins.dbPassword) execEnv = { PGPASSWORD: ins.dbPassword };
    }
  } else {
    if (target.engine === 'mongo') {
      command = mg.mongoUriRestoreCommand();
      execEnv = { MONGOURI: uri };
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
  // pg_restore writes nothing useful to stdout, but we must drain it.
  // If nobody reads the stdout PassThrough its buffer fills, backpressure
  // stalls child.stdout, and the process hangs waiting to flush — never exiting.
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

    // stderr from pg_restore --verbose / errors — collect for the final
    // failure message and stream lines to the renderer for live diagnosis.
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

    let streamDone = false; // true when exit OR close fires — whichever comes first
    stream.on('exit', (code, sig) => {
      exitCode = code; exitSignal = sig;
      // On WSL/Docker, 'close' may never fire because the OS stdout pipe stays
      // open past the child's exit. 'exit' alone proves pg_restore finished.
      streamDone = true;
      if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
    });
    stream.on('close', () => {
      streamDone = true;
      if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
    });

    // Stall detector — police bytes flowing INTO the remote channel (i.e.
    // bytes we've written to stdin). If our local decrypt/pipe stalls or the
    // remote channel stops accepting writes, we want to know.
    const WARN_MS = 30_000;
    const STUCK_MS = 5 * 60_000;
    const POST_EOF_MS = 30 * 60_000; // pg_restore rebuilds indexes/constraints after EOF — can take many minutes
    let lastByteAt = Date.now();
    let stallWarned = false;
    stallTimer = setInterval(() => {
      const idle = Date.now() - lastByteAt;
      if (idle >= STUCK_MS) {
        clearInterval(stallTimer); stallTimer = null;
        onErr(new Error('No data accepted by pg_restore for ' + Math.round(idle / 1000) + 's — declaring stuck. Check the Logs drawer for pg_restore stderr.'));
        return;
      }
      if (idle >= WARN_MS && !stallWarned) {
        stallWarned = true;
        emit('stalled', { idleMs: idle });
      }
    }, 5_000);

    const src = fs.createReadStream(dumpPath);
    const decrypt = new DecryptStream(dumpKey);
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
    decrypt.on('error', onErr);
    tee.on('error', onErr);

    // local file -> decrypt -> tee -> remote stdin
    src.pipe(decrypt).pipe(tee).pipe(stream.stdin);

    // When tee ends (entire decrypted dump written), close remote stdin so
    // pg_restore knows there's no more input and can finalize.
    // Clear the stdin-stall watchdog here — all data has been written so
    // "no bytes written" is expected. The post-EOF timer takes over.
    tee.on('end', () => {
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
      try { stream.stdin.end(); } catch {}
      emit('finalizing');
      // Wait for remote process to actually finish.
      const waitedAt = Date.now();
      const wait = () => {
        if (streamDone) {
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          if (exitCode !== 0) {
            return onErr(new Error(
              'pg_restore exited with code ' + exitCode +
              (exitSignal ? ' (signal ' + exitSignal + ')' : '') +
              (stderrBuf ? '\n' + stderrBuf.trim() : '')
            ));
          }
          try { ch && ch.end(); } catch {}
          const finishedAt = new Date();
          const meta = {
            schemaVersion: 1,
            op: 'restore',
            engine: 'postgres',
            serverId: server ? server.id : null,
            serverName: server ? server.name : null,
            targetId: target.id,
            targetName: target.name,
            envTag: target.envTag,
            dbName: target.dbName,
            cleanFirst: !!cleanFirst,
            dumpPath,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt - startedAt,
            bytesIn,
            sha256Plaintext: sha.digest('hex'),
          };
          return finish(() => resolve({ ...meta, stderr: stderrBuf.trim() || null }));
        }
        if (Date.now() - waitedAt >= POST_EOF_MS) {
          return onErr(new Error('pg_restore did not exit ' + Math.round(POST_EOF_MS / 1000) + 's after stdin closed — declaring channel hung.'));
        }
        postEofTimerRef.current = setTimeout(wait, 500);
      };
      wait();
    });
  });
}

module.exports = { run };
