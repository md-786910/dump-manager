'use strict';

// Postgres backup: opens an exec channel (SSH or local) to the Server (or to
// localhost for external-uri targets), runs pg_dump inside a docker-compose
// service (docker-compose-vps target) OR directly via libpq (external-uri
// target), and streams stdout straight into a locally-encrypted file.
// No temp files anywhere.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const channel = require('../exec/channel');
const { resolveDockerSudo } = require('../exec/dockerSudo');
const { EncryptStream } = require('../crypto/stream');
const pg = require('../db/postgres');
const mg = require('../db/mongo');
const dumps = require('../storage/dumps');

// `opts`:
//   server, target    — resolved records (server may be null for external-uri)
//   privateKey        — Buffer (only used for SSH servers)
//   passphrase        — string | undefined (SSH only)
//   uri               — string (external-uri targets only — caller decrypts)
//   dumpKey           — 32-byte Buffer from keychain.ensure()
//   knownHosts        — api from ssh/knownHosts.js (SSH only)
//   userDataApp       — Electron `app` (for dumps.ensureDir)
//   onUntrustedHost   — optional TOFU prompt callback (SSH only)
//   onProgress        — optional ({ bytes }) => void as ciphertext is written
//   signal            — optional AbortSignal
//
// Resolves with the sidecar metadata + { path }. On failure removes the
// partial dump + sidecar.
async function run(opts) {
  const {
    server, target, privateKey, passphrase, uri, dumpKey,
    knownHosts, userDataApp, onUntrustedHost, onProgress, signal,
  } = opts;

  if (!target) throw new Error('target is required');
  if (target.kind === 'docker-compose-vps') {
    if (!server) throw new Error('server is required for docker-compose-vps target');
  } else if (target.kind === 'external-uri') {
    if (!uri) throw new Error('uri is required for external-uri target');
  } else if (target.kind === 'installed') {
    // server optional (null = run on this machine). installed.host required.
    if (!target.installed || !target.installed.host) throw new Error('installed.host is required');
  } else {
    throw new Error('unsupported target.kind: ' + target.kind);
  }
  const isLocal = !server || server.kind === 'local' || target.kind === 'external-uri' || target.kind === 'installed';

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
  let client = null; // legacy alias for the ssh client (may be null for local)
  let ch = null;
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
    client = ch.client;
  } catch (err) {
    if (aborted) throw new Error('cancelled');
    throw err;
  }
  if (aborted) throw new Error('cancelled');
  emit('authenticated');

  let command;
  let execEnv;
  if (target.kind === 'docker-compose-vps') {
    const sudo = await resolveDockerSudo(ch, server);
    if (target.engine === 'mongo') {
      command = mg.mongoDumpCommand({
        composeBin: server.composeBin,
        sudo,
        composeProjectPath: target.vps && target.vps.composeProjectPath,
        projectName: target.vps && target.vps.projectName,
        service: target.vps.service,
        dbName: target.dbName,
        mongoUser: target.vps && target.vps.mongoUser,
        mongoPassword: target.vps && target.vps.mongoPassword,
        mongoAuthDb: target.vps && target.vps.mongoAuthDb,
      });
    } else {
      command = pg.vpsDumpCommand({
        composeBin: server.composeBin,
        sudo,
        composeProjectPath: target.vps && target.vps.composeProjectPath,
        projectName: target.vps && target.vps.projectName,
        service: target.vps.service,
        dbName: target.dbName,
        pgUser: target.vps && target.vps.pgUser,
        compressionLevel: target.vps && target.vps.compressionLevel,
      });
    }
  } else if (target.kind === 'installed') {
    // Installed DB — pg_dump / mongodump run directly (no docker compose wrapper).
    // For local channels: pass password via spawn env (cleaner).
    // For SSH channels: embed PGPASSWORD/MONGO_PWD inline (SSH env forwarding is unreliable).
    const ins = target.installed;
    const embedPassword = !!(server && server.kind === 'ssh');
    if (target.engine === 'mongo') {
      command = mg.mongoInstalledDumpCommand({
        host: ins.host, port: ins.port, dbName: target.dbName,
        mongoUser: ins.dbUser, mongoPassword: ins.dbPassword,
        mongoAuthDb: ins.mongoAuthDb, embedPassword,
      });
      if (!embedPassword && ins.dbPassword) execEnv = { MONGO_PWD: ins.dbPassword };
    } else {
      command = pg.installedDumpCommand({
        host: ins.host, port: ins.port, dbUser: ins.dbUser, dbName: target.dbName,
        compressionLevel: null, embedPassword, dbPassword: ins.dbPassword,
      });
      if (!embedPassword && ins.dbPassword) execEnv = { PGPASSWORD: ins.dbPassword };
    }
  } else {
    // external-uri — pass URI via env so it isn't visible in process listings.
    if (target.engine === 'mongo') {
      command = mg.mongoUriDumpCommand();
      execEnv = { MONGOURI: uri };
    } else {
      command = pg.uriDumpCommand({ compressionLevel: target.uriOpts && target.uriOpts.compressionLevel });
      execEnv = { PGURI: uri };
    }
  }

  emit('starting-dump');
  try {
    stream = await ch.exec(command, execEnv ? { env: execEnv } : undefined);
  } catch (err) {
    ch.end();
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
        if (postEofTimerRef.current) { clearTimeout(postEofTimerRef.current); postEofTimerRef.current = null; }
        try { stream && stream.destroy && stream.destroy(); } catch {}
        try { ch && ch.end(); } catch {}
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
      try { ch && ch.end(); } catch {}
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
        engine: target.engine || 'postgres',
        format: target.engine === 'mongo' ? 'mongodump_archive' : 'pg_custom',
        serverId: server ? server.id : null,
        serverName: server ? server.name : null,
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
