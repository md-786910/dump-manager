'use strict';

// Unified exec channel over SSH (ssh2) and local processes (child_process).
// The backup/restore/discovery ops use a single interface so they don't have
// to fork into separate "vps" and "local" copies.
//
// Channel shape:
//   { kind, client, exec(cmd) -> Promise<stream>, end() }
//
// Stream shape (matches ssh2's exec channel so existing pipelines work):
//   stream                : Readable for stdout (.pipe ok)
//   stream.stderr         : Readable
//   stream.stdin          : Writable
//   stream.on('exit', (code, signal))
//   stream.on('close')
//   stream.on('error')
//   stream.signal(sig)    : best-effort signal to the remote/local process
//   stream.destroy()      : force close

const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');

const sshClient = require('../ssh/client');

async function connect(server, opts) {
  // null server OR server.kind === 'local' -> local channel.
  if (!server || server.kind === 'local') {
    return makeLocalChannel(server);
  }
  // Default: SSH channel.
  const client = await sshClient.connect({
    host: server.host,
    port: server.port,
    username: server.user,
    privateKey: opts && opts.privateKey,
    passphrase: opts && opts.passphrase,
    knownHosts: opts && opts.knownHosts,
    onUntrustedHost: opts && opts.onUntrustedHost,
    onProgress: opts && opts.onProgress,
  });
  return {
    kind: 'ssh',
    client,
    exec: (cmd, execOpts) => sshClient.exec(client, cmd, execOpts),
    end: () => { try { client.end(); } catch {} },
  };
}

function makeLocalChannel(server) {
  // Local channel has no persistent client — each exec spawns its own process.
  // The "server" reference is retained so callers can read sudoForDocker
  // and wslDistro.
  return {
    kind: 'local',
    client: null,
    server: server || null,
    exec: (cmd, execOpts) => Promise.resolve(spawnShellStream(cmd, execOpts, server)),
    end: () => { /* no-op */ },
  };
}

// Spawn a shell command and adapt the ChildProcess to look like ssh2's
// exec stream. Three execution modes:
//   - POSIX (Linux/macOS): /bin/sh -c <cmd>
//   - Windows + no WSL: cmd.exe /c <cmd>
//   - Windows + server.wslDistro set: wsl.exe -d <distro> -- /bin/sh -c <cmd>
//
// In the WSL mode the command runs inside the chosen WSL distro, so callers
// don't need to know whether docker lives on Windows or inside WSL. Env vars
// supplied via execOpts.env are propagated through WSLENV (semicolon-free
// names listed in WSLENV cross the boundary).
function spawnShellStream(cmd, execOpts, server) {
  const isWin = process.platform === 'win32';
  const wslDistro = server && server.kind === 'local' && server.wslDistro;
  const extraEnv = (execOpts && execOpts.env) || null;

  let bin, args;
  let envOverride = null;
  if (wslDistro && isWin) {
    // Run cmd inside the chosen WSL distro. /bin/sh -c <cmd> mirrors the
    // POSIX mode so command strings (cd … && docker compose exec …) work
    // identically.
    bin = 'wsl.exe';
    args = ['-d', wslDistro, '--', '/bin/sh', '-c', cmd];
    if (extraEnv) {
      // Forward env vars across the Win→WSL boundary via WSLENV.
      const names = Object.keys(extraEnv);
      const existingWslEnv = process.env.WSLENV || '';
      const wslenv = [existingWslEnv, ...names.map((n) => n + '/u')]
        .filter(Boolean).join(':');
      envOverride = { ...process.env, ...extraEnv, WSLENV: wslenv };
    }
  } else if (isWin) {
    bin = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', cmd];
  } else {
    bin = '/bin/sh';
    args = ['-c', cmd];
  }

  const child = spawn(bin, args, {
    env: envOverride || (extraEnv ? { ...process.env, ...extraEnv } : process.env),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Proxy stdout through a PassThrough so consumers can attach .on('data')
  // and also .pipe(...) without ChildProcess quirks. We pass {end:false} so
  // the PassThrough's own 'close' doesn't fire when child.stdout ends — we
  // emit 'exit' and 'close' ourselves in ssh2's order (exit first, then close).
  const stdout = new PassThrough();
  child.stdout.pipe(stdout, { end: false });
  child.stdout.on('error', (err) => stdout.destroy(err));

  // Surface child errors (e.g. shell not found) on the stdout stream.
  child.on('error', (err) => stdout.destroy(err));

  let exitCode = null;
  let exitSignal = null;

  // Emit 'exit' first (matching ssh2's ordering), then use child.on('close')
  // to emit 'close' once Node.js confirms all stdio FDs are closed.
  // child.on('close') is reliable on all platforms — WSL, Docker exec, POSIX —
  // because Node.js waits for OS-level stdio close before firing it. The
  // previous two-condition approach (childExited && stdoutEnded) was unreliable:
  // on WSL/Docker, child.stdout.on('end') can fail to fire because the OS pipe
  // stays open past the child's exit.
  child.on('exit', (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    stdout.emit('exit', code, signal);
  });

  child.on('close', () => {
    if (!stdout._dbmClosed) {
      stdout._dbmClosed = true;
      stdout.end();
      stdout.emit('close', exitCode, exitSignal);
    }
  });

  // Attach the ssh2-style helpers onto the stdout PassThrough so the
  // existing call sites work unchanged.
  stdout.stderr = child.stderr;
  stdout.stdin = child.stdin;
  stdout.signal = (sig) => {
    try { child.kill('SIG' + String(sig).replace(/^SIG/, '')); } catch {}
  };
  // PassThrough already has .destroy(); override to also kill the child.
  const origDestroy = stdout.destroy.bind(stdout);
  stdout.destroy = (err) => {
    try { child.kill('SIGKILL'); } catch {}
    return origDestroy(err);
  };

  return stdout;
}

module.exports = { connect };
