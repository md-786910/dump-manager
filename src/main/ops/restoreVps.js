'use strict';

// VPS Postgres restore: opens an SSH connection to the Server, runs
// `<composeBin> exec -T <service> pg_restore -d <db>` inside the remote
// container, and streams a *decrypted* local dump straight into stdin.
//
// Mirrors backupVps.js — same watchdog patterns, same progress phases.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const sshClient = require('../ssh/client');
const { DecryptStream } = require('../crypto/stream');
const pg = require('../db/postgres');

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
    server, target, dumpPath, cleanFirst,
    privateKey, passphrase, dumpKey,
    knownHosts, onUntrustedHost, onProgress, signal,
  } = opts;

  if (!server) throw new Error('server is required');
  if (!target) throw new Error('target is required');
  if (!dumpPath) throw new Error('dumpPath is required');
  if (target.kind !== 'docker-compose-vps') throw new Error('expected docker-compose-vps target');
  if (!fs.existsSync(dumpPath)) throw new Error('dump file not found: ' + dumpPath);

  const startedAt = new Date();
  const emit = (phase, extra) => { if (onProgress) try { onProgress({ phase, ...(extra || {}) }); } catch {} };

  let client = null;
  let stream = null;
  let promiseOnErr = null;
  let aborted = false;

  const tearDownForAbort = () => {
    aborted = true;
    if (stream) {
      try { stream.signal && stream.signal('TERM'); } catch {}
      try { stream.destroy && stream.destroy(); } catch {}
    }
    if (client) { try { client.end(); } catch {} }
  };

  const onAbort = () => {
    tearDownForAbort();
    if (promiseOnErr) promiseOnErr(new Error('cancelled'));
  };

  if (signal) {
    if (signal.aborted) throw new Error('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
  }

  emit('ssh-connecting');
  try {
    client = await sshClient.connect({
      host: server.host,
      port: server.port,
      username: server.user,
      privateKey,
      passphrase,
      knownHosts,
      onUntrustedHost,
      onProgress: (p) => { if (p && p.phase) emit(p.phase); },
    });
  } catch (err) {
    if (aborted) throw new Error('cancelled');
    throw err;
  }
  if (aborted) throw new Error('cancelled');
  emit('authenticated');

  const command = pg.vpsRestoreCommand({
    composeBin: server.composeBin,
    sudo: !!server.sudoForDocker,
    composeProjectPath: target.vps && target.vps.composeProjectPath,
    projectName: target.vps && target.vps.projectName,
    service: target.vps.service,
    dbName: target.dbName,
    pgUser: target.vps && target.vps.pgUser,
    cleanFirst: !!cleanFirst,
  });

  emit('starting-restore');
  try {
    stream = await sshClient.exec(client, command);
  } catch (err) {
    try { client.end(); } catch {}
    if (aborted) throw new Error('cancelled');
    throw err;
  }
  if (aborted) throw new Error('cancelled');
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
        try { client && client.end(); } catch {}
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

    let streamClosed = false;
    stream.on('exit', (code, sig) => { exitCode = code; exitSignal = sig; });
    stream.on('close', () => {
      streamClosed = true;
      if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
    });

    // Stall detector — police bytes flowing INTO the remote channel (i.e.
    // bytes we've written to stdin). If our local decrypt/pipe stalls or the
    // remote channel stops accepting writes, we want to know.
    const WARN_MS = 30_000;
    const STUCK_MS = 5 * 60_000;
    const POST_EOF_MS = 30_000; // pg_restore may take longer than dump to finalize after stdin ends
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
    tee.on('end', () => {
      try { stream.stdin.end(); } catch {}
      emit('finalizing');
      // Wait for remote process to actually finish.
      const waitedAt = Date.now();
      const wait = () => {
        if (streamClosed) {
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          if (exitCode !== 0) {
            return onErr(new Error(
              'pg_restore exited with code ' + exitCode +
              (exitSignal ? ' (signal ' + exitSignal + ')' : '') +
              (stderrBuf ? '\n' + stderrBuf.trim() : '')
            ));
          }
          try { client.end(); } catch {}
          const finishedAt = new Date();
          const meta = {
            schemaVersion: 1,
            op: 'restore',
            engine: 'postgres',
            serverId: server.id,
            serverName: server.name,
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
