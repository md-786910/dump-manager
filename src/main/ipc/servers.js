'use strict';

const { ipcMain, BrowserWindow, dialog } = require('electron');

const sshClient = require('../ssh/client');
const testConnection = require('../ops/testConnection');
const channel = require('../exec/channel');
const logging = require('../logging');

function register({ servers, targets, knownHosts, passphraseCache, audit, app }) {
  ipcMain.handle('servers:list', () => servers.list());
  ipcMain.handle('servers:create', (_e, input) => servers.create(input));
  ipcMain.handle('servers:update', (_e, { id, patch }) => servers.update(id, patch));
  ipcMain.handle('servers:delete', (_e, { id, cascade }) => {
    if (cascade) targets.removeManyByServer(id);
    servers.remove(id);
    passphraseCache.drop(id);
    return { ok: true };
  });

  // --- Connection lifecycle ---

  ipcMain.handle('connection:test', async (event, { serverId, passphrase }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const startedAt = Date.now();
    let server;
    try { server = servers.get(serverId); }
    catch (err) { return { ok: false, error: err.message }; }

    // Local server probe: just run `docker compose version` (with sudo if
    // configured), no SSH, no passphrase prompt.
    if (server.kind === 'local') {
      try {
        const ch = await channel.connect(server);
        const stream = await ch.exec((server.sudoForDocker ? 'sudo ' : '') + 'docker compose version --short 2>/dev/null || docker-compose --version 2>/dev/null');
        const result = await new Promise((resolve, reject) => {
          let stdout = '', exitCode = null;
          stream.on('data', (c) => { stdout += c.toString('utf8'); });
          stream.on('exit', (code) => { exitCode = code; });
          stream.on('close', () => resolve({ stdout, exitCode }));
          stream.on('error', reject);
        });
        if (result.exitCode !== 0 || !result.stdout.trim()) {
          throw new Error('No docker compose found on this machine. Install Docker Desktop or docker-compose, or enable the sudo toggle.');
        }
        audit.append(app, {
          op: 'connect', serverId, serverName: server.name,
          ok: true, durationMs: Date.now() - startedAt,
        });
        logging.info('connection', 'Local docker reachable for ' + server.name, { version: result.stdout.trim() });
        return { ok: true, local: true, dockerComposeVersion: result.stdout.trim() };
      } catch (err) {
        audit.append(app, {
          op: 'connect', serverId, serverName: server.name,
          ok: false, error: err.message, durationMs: Date.now() - startedAt,
        });
        logging.warn('connection', 'Local probe failed for ' + server.name + ': ' + err.message);
        return { ok: false, error: err.message };
      }
    }

    try {
      const effectivePass = passphrase || passphraseCache.get(serverId) || '';
      const privateKey = sshClient.loadPrivateKey(server.privateKeyPath);

      await testConnection.run({
        server,
        privateKey,
        passphrase: effectivePass || undefined,
        knownHosts,
        onUntrustedHost: async ({ host, port, fingerprint, keyType }) => {
          const res = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Trust and continue', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Unknown SSH host',
            message: 'Trust ' + host + ':' + port + '?',
            detail:
              'This host has not been seen before.\n\n' +
              keyType + ' fingerprint:\n' + fingerprint + '\n\n' +
              'Only continue if this fingerprint matches the one printed by ssh-keyscan or your VPS provider.',
            noLink: true,
          });
          return res.response === 0;
        },
      });

      // Cache only if the caller actually supplied a passphrase.
      if (passphrase) passphraseCache.set(serverId, passphrase);

      audit.append(app, {
        op: 'connect',
        serverId, serverName: server.name,
        ok: true, durationMs: Date.now() - startedAt,
      });
      logging.info('connection', 'Connected to ' + server.name, {
        serverId, host: server.host, user: server.user,
      });
      return { ok: true };
    } catch (err) {
      audit.append(app, {
        op: 'connect',
        serverId, serverName: server && server.name,
        ok: false, error: err.message, code: err.code || null,
        durationMs: Date.now() - startedAt,
      });
      // The "empty passphrase rejected" path is expected — log at warn so it
      // isn't visually loud in the UI.
      const level = /authentication|passphrase/i.test(err.message) ? 'warn' : 'error';
      logging.log(level, 'connection', 'Connect failed for ' + (server && server.name) + ': ' + err.message, {
        serverId, code: err.code,
      });
      return { ok: false, error: err.message, code: err.code || null };
    }
  });

  ipcMain.handle('connection:disconnect', (_e, serverId) => {
    passphraseCache.drop(serverId);
    const s = servers.list().find((x) => x.id === serverId);
    logging.info('connection', 'Disconnected from ' + (s ? s.name : serverId), { serverId });
    return { ok: true };
  });

  ipcMain.handle('connection:status', (_e, serverId) => ({
    connected: passphraseCache.has(serverId),
  }));

  ipcMain.handle('connection:statusAll', () => {
    const out = {};
    for (const s of servers.list()) out[s.id] = passphraseCache.has(s.id);
    return out;
  });
}

module.exports = { register };
