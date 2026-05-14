'use strict';

// VPS Postgres backup: opens an SSH connection to the Server, runs
// `<composeBin> exec -T <service> pg_dump -Fc -d <db>` inside the remote
// container, and streams stdout straight into a locally-encrypted file.
// No temp files anywhere.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const sshClient = require('../ssh/client');
const { EncryptStream } = require('../crypto/stream');
const pg = require('../db/postgres');
const dumps = require('../storage/dumps');

// `opts`:
//   server, target    — resolved records
//   privateKey        — Buffer (read from server.privateKeyPath by caller)
//   passphrase        — string | undefined
//   dumpKey           — 32-byte Buffer from keychain.ensure()
//   knownHosts        — api from ssh/knownHosts.js
//   userDataApp       — Electron `app` (for dumps.ensureDir)
//   onUntrustedHost   — optional TOFU prompt callback
//   onProgress        — optional ({ bytes }) => void as ciphertext is written
//   signal            — optional AbortSignal
//
// Resolves with the sidecar metadata + { path }. On failure removes the
// partial dump + sidecar.
async function run(opts) {
  const {
    server, target, privateKey, passphrase, dumpKey,
    knownHosts, userDataApp, onUntrustedHost, onProgress, signal,
  } = opts;

  if (!server) throw new Error('server is required');
  if (!target) throw new Error('target is required');
  if (target.kind !== 'docker-compose-vps') throw new Error('expected docker-compose-vps target');

  dumps.ensureDir(userDataApp);
  const startedAt = new Date();
  const dumpFile = path.join(
    dumps.dumpDir(userDataApp),
    dumps.buildDumpName({ name: target.name, dbName: target.dbName }, startedAt),
  );

  const emit = (phase, extra) => { if (onProgress) try { onProgress({ phase, ...(extra || {}) }); } catch {} };

  // Abort state is owned by the whole run, not just the Promise body, so a
  // cancel during sshClient.connect or sshClient.exec (which happen *before*
  // the Promise) still tears the right things down.
  let client = null;
  let stream = null;
  let promiseOnErr = null; // set once the Promise body installs its error path
  let aborted = false;

  const tearDownForAbort = () => {
    aborted = true;
    if (stream) {
      // Send SIGTERM to the remote process group so docker-compose-exec / pg_dump
      // dies promptly instead of waiting for SIGPIPE on the next stdout write.
      try { stream.signal && stream.signal('TERM'); } catch {}
      try { stream.destroy && stream.destroy(); } catch {}
    }
    if (client) {
      try { client.end(); } catch {}
    }
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

  const command = pg.vpsDumpCommand({
    composeBin: server.composeBin,
    sudo: !!server.sudoForDocker,
    composeProjectPath: target.vps && target.vps.composeProjectPath,
    projectName: target.vps && target.vps.projectName,
    service: target.vps.service,
    dbName: target.dbName,
    pgUser: target.vps && target.vps.pgUser,
    compressionLevel: target.vps && target.vps.compressionLevel,
  });

  emit('starting-dump');
  try {
    stream = await sshClient.exec(client, command);
  } catch (err) {
    try { client.end(); } catch {}
    if (aborted) throw new Error('cancelled');
    throw err;
  }
  if (aborted) throw new Error('cancelled');
  emit('waiting'); // exec sent; waiting for first byte from pg_dump

  return new Promise((resolve, reject) => {
    let bytesOut = 0;
    let stderrBuf = '';
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; fn(); };

    const sha = crypto.createHash('sha256');
    const encrypt = new EncryptStream(dumpKey);
    const sink = fs.createWriteStream(dumpFile, { mode: 0o600 });

    let stallTimer = null;
    const postEofTimerRef = { current: null };
    const onErr = (err) => {
      finish(() => {
        if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
        if (postEofTimerRef.currentRef.current) { clearTimeout(postEofTimerRef.currentRef.current); postEofTimerRef.currentRef.current = null; }
        try { stream && stream.destroy && stream.destroy(); } catch {}
        try { client && client.end(); } catch {}
        try { sink.destroy(); } catch {}
        try { fs.existsSync(dumpFile) && fs.unlinkSync(dumpFile); } catch {}
        reject(err);
      });
    };
    promiseOnErr = onErr;

    // If the abort already fired between exec and here, take the cancellation
    // path immediately. (The 'aborted' flag is set synchronously by the
    // listener attached at the top of run().)
    if (aborted) return onErr(new Error('cancelled'));

    stream.on('error', onErr);
    encrypt.on('error', onErr);
    sink.on('error', onErr);

    // stderr from pg_dump --verbose. We keep an in-memory tail for the final
    // error message, and stream each line up to the renderer as a separate
    // event so a "stuck" backup is diagnosable in real time.
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

    // Stall detector: warn if no new bytes have arrived in WARN_MS, abort if
    // STUCK_MS passes with no activity. The check fires every 5s.
    //
    // Crucially we tap the *raw* ssh2 stream (upstream of EncryptStream) so
    // trickle output from pg_dump resets the timer even if encryption is
    // buffering — and so the timer keeps policing the op after the local
    // pipeline (encrypt → tee → sink) has flushed but the remote process
    // hasn't exited yet (e.g. blocked on an ACCESS SHARE lock with stdout
    // already closed). Empty chunks are ignored.
    const WARN_MS = 30_000;
    const STUCK_MS = 5 * 60_000;
    const POST_EOF_MS = 15_000; // hard deadline after stdout EOF before we declare the channel hung
    let lastByteAt = Date.now();
    let stallWarned = false;
    stallTimer = setInterval(() => {
      const idle = Date.now() - lastByteAt;
      if (idle >= STUCK_MS) {
        clearInterval(stallTimer); stallTimer = null;
        onErr(new Error('No data from pg_dump for ' + Math.round(idle / 1000) + 's — declaring stuck. Check the Logs drawer for pg_dump stderr.'));
        return;
      }
      if (idle >= WARN_MS && !stallWarned) {
        stallWarned = true;
        emit('stalled', { idleMs: idle });
      }
    }, 5_000);
    // NOTE: deliberately not unref()-ing the timer. In Electron's main process
    // an unref'd interval whose only strong refs live inside this Promise body
    // can stop firing under GC pressure, defeating the entire safety net.

    // Raw-byte heartbeat — see comment above.
    stream.on('data', (chunk) => {
      if (chunk && chunk.length) lastByteAt = Date.now();
    });

    const tee = new PassThrough();
    let firstChunk = true;
    tee.on('data', (chunk) => {
      if (!chunk || !chunk.length) return;
      if (stallWarned) { stallWarned = false; emit('resumed'); }
      if (firstChunk) { firstChunk = false; emit('streaming', { bytes: 0 }); }
      sha.update(chunk);
      bytesOut += chunk.length;
      if (onProgress) onProgress({ phase: 'streaming', bytes: bytesOut });
    });

    stream.pipe(encrypt).pipe(tee).pipe(sink);

    // Register stream.on('close') ONCE up front so we don't miss it racing
    // sink.on('finish'). Buffer the close fact; the resolver below checks it.
    stream.on('close', () => {
      streamClosed = true;
      if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
    });

    const finalizeSuccess = () => {
      if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
      if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
      try { client.end(); } catch {}
      if (exitCode !== 0) {
        return onErr(new Error(
          'pg_dump exited with code ' + exitCode +
          (exitSignal ? ' (signal ' + exitSignal + ')' : '') +
          (stderrBuf ? '\n' + stderrBuf.trim() : '')
        ));
      }
      const finishedAt = new Date();
      const meta = {
        schemaVersion: 2,
        engine: 'postgres',
        format: 'pg_custom',
        serverId: server.id,
        serverName: server.name,
        sourceProfileId: target.id, // legacy field name kept for sidecar compatibility
        sourceProfileName: target.name,
        envTag: target.envTag,
        dbName: target.dbName,
        createdAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt - startedAt,
        byteSize: bytesOut,
        sha256Ciphertext: sha.digest('hex'),
      };
      dumps.writeSidecar(dumpFile, meta);
      finish(() => resolve({ path: dumpFile, ...meta, stderr: stderrBuf.trim() || null }));
    };

    sink.on('finish', () => {
      // Local pipeline drained. The remote process may already have exited
      // (streamClosed === true) or may still be wrapping up. We wait up to
      // POST_EOF_MS for the channel to fully close; otherwise we declare the
      // channel hung — this is the case the old code would freeze on.
      if (streamClosed) return finalizeSuccess();
      const waitedAt = Date.now();
      const wait = () => {
        if (streamClosed) return finalizeSuccess();
        if (Date.now() - waitedAt >= POST_EOF_MS) {
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          return onErr(new Error('Remote process did not exit ' + Math.round(POST_EOF_MS / 1000) + 's after stdout closed — declaring channel hung.'));
        }
        postEofTimerRef.current = setTimeout(wait, 500);
      };
      wait();
    });
  });
}

module.exports = { run };
