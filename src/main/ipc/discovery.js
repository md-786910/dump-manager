'use strict';

const { ipcMain, BrowserWindow, dialog } = require('electron');
const crypto = require('node:crypto');

const discovery = require('../ops/discovery');
const sshClient = require('../ssh/client');
const logging = require('../logging');

function register({ servers, knownHosts, passphraseCache, audit, app }) {
  ipcMain.handle('discovery:run', async (event, { serverId, passphrase }) => {
    const opId = 'op-' + crypto.randomUUID();
    const win = BrowserWindow.fromWebContents(event.sender);
    const send = (channel, payload) => { try { win && win.webContents.send(channel, payload); } catch {} };
    const startedAt = Date.now();

    let server;
    try { server = servers.get(serverId); }
    catch (err) {
      logging.error('discovery', 'Cannot resolve server: ' + err.message, { serverId });
      return { opId, ok: false, error: err.message };
    }

    logging.info('discovery', 'Discovering compose projects on ' + server.name, { serverId });

    try {
      // For local servers there's no SSH key or passphrase to load.
      const isLocal = server.kind === 'local';
      const effectivePass = isLocal ? undefined : (passphrase || passphraseCache.get(serverId) || '');
      const privateKey = isLocal ? null : sshClient.loadPrivateKey(server.privateKeyPath);

      const result = await discovery.run({
        server,
        privateKey,
        passphrase: effectivePass || undefined,
        knownHosts,
        onProgress: (p) => send('discovery:progress', { opId, ...p }),
        onUntrustedHost: async ({ host, port, fingerprint, keyType }) => {
          const res = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Trust and continue', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Unknown SSH host',
            message: 'Trust ' + host + ':' + port + '?',
            detail: keyType + ' fingerprint:\n' + fingerprint,
            noLink: true,
          });
          return res.response === 0;
        },
      });

      // Cache the passphrase only if discovery succeeded and one was provided.
      if (passphrase && !isLocal) passphraseCache.set(serverId, passphrase);

      // Persist the detected composeBin on the Server for the next run.
      if (server.composeBin !== result.composeBin) {
        servers.update(serverId, { composeBin: result.composeBin });
      }

      audit.append(app, {
        op: 'discovery',
        serverId,
        serverName: server.name,
        ok: true,
        durationMs: Date.now() - startedAt,
        projectCount: result.projects.length,
      });

      logging.info('discovery', 'Discovery completed: ' + result.projects.length + ' project(s) on ' + server.name, {
        serverId, composeBin: result.composeBin, composeVersion: result.composeVersion,
        projectNames: result.projects.map((p) => p.name),
      });
      return { opId, ok: true, result };
    } catch (err) {
      audit.append(app, {
        op: 'discovery',
        serverId,
        serverName: server && server.name,
        ok: false,
        error: err.message,
        code: err.code || null,
        durationMs: Date.now() - startedAt,
      });
      logging.error('discovery', 'Discovery failed on ' + server.name + ': ' + err.message, {
        serverId, code: err.code, stack: err.stack,
      });
      return { opId, ok: false, error: err.message, code: err.code || null };
    }
  });

  // Light version for the Target editor — lists compose projects + services
  // only (no databases). Fires on modal open when the server is connected.
  ipcMain.handle('compose:listProjects', async (event, { serverId, passphrase }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    let server;
    try { server = servers.get(serverId); }
    catch (err) { return { ok: false, error: err.message }; }

    try {
      const isLocal = server.kind === 'local';
      const effectivePass = isLocal ? undefined : (passphrase || passphraseCache.get(serverId) || '');
      const privateKey = isLocal ? null : sshClient.loadPrivateKey(server.privateKeyPath);

      const result = await discovery.listProjects({
        server,
        privateKey,
        passphrase: effectivePass || undefined,
        knownHosts,
        onUntrustedHost: async ({ host, port, fingerprint, keyType }) => {
          const r = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Trust and continue', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'Unknown SSH host',
            message: 'Trust ' + host + ':' + port + '?',
            detail: keyType + ' fingerprint:\n' + fingerprint,
            noLink: true,
          });
          return r.response === 0;
        },
      });

      if (passphrase && !isLocal) passphraseCache.set(serverId, passphrase);
      if (server.composeBin !== result.composeBin) {
        servers.update(serverId, { composeBin: result.composeBin });
      }
      logging.debug('compose', 'Listed ' + result.projects.length + ' compose project(s) on ' + server.name, { serverId });
      return { ok: true, ...result };
    } catch (err) {
      logging.warn('compose', 'compose:listProjects failed on ' + (server && server.name) + ': ' + err.message, {
        serverId, code: err.code,
      });
      return { ok: false, error: err.message, code: err.code || null };
    }
  });
}

module.exports = { register };
