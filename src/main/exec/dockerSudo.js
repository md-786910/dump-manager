'use strict';

// Resolves the effective `sudo` flag for docker commands on a given server.
//
// Why: a packaged Electron app has no TTY, so plain `sudo docker …` hangs
// forever on the password prompt. Most local users (Linux docker group,
// Docker Desktop on Mac/Win) don't need sudo at all. This helper probes once
// per session and tells callers whether sudo is truly required.
//
// Returns a boolean. Result is cached in memory keyed by server.id.

const runCommand = require('./runCommand');

const cache = new Map();

async function resolveDockerSudo(ch, server) {
  if (!server) return false;
  if (server.kind !== 'local') return !!server.sudoForDocker;

  if (cache.has(server.id)) return cache.get(server.id);

  // Try unprivileged first regardless of the saved flag.
  const v = await runCommand(ch, 'docker compose version --short 2>/dev/null');
  if (v.exitCode === 0 && v.stdout.trim()) {
    cache.set(server.id, false);
    return false;
  }

  if (!server.sudoForDocker) {
    throw Object.assign(
      new Error(
        'Docker is not accessible. Either Docker is not installed/running, or ' +
        'your user is not in the docker group. Run: sudo usermod -aG docker $USER, ' +
        'then log out and back in.'
      ),
      { code: 'DOCKER_UNAVAILABLE' }
    );
  }

  // Sudo was requested. Try non-interactively so packaged apps fail fast
  // instead of hanging on a password prompt.
  const vs = await runCommand(ch, 'sudo -n docker compose version --short 2>/dev/null');
  if (vs.exitCode === 0 && vs.stdout.trim()) {
    cache.set(server.id, true);
    return true;
  }

  throw Object.assign(
    new Error(
      'Docker requires a sudo password locally, but the app cannot prompt for one. ' +
      'Add your user to the docker group (sudo usermod -aG docker $USER, then log out/in) ' +
      'or configure passwordless sudo (NOPASSWD) for docker.'
    ),
    { code: 'DOCKER_SUDO_PASSWORD_REQUIRED' }
  );
}

function invalidate(serverId) {
  if (serverId == null) cache.clear();
  else cache.delete(serverId);
}

module.exports = { resolveDockerSudo, invalidate };
