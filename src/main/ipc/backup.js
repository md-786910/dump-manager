'use strict';

const { ipcMain, BrowserWindow, dialog } = require('electron');
const crypto = require('node:crypto');

const backupVps = require('../ops/backupVps');
const restoreVps = require('../ops/restoreVps');
const sshClient = require('../ssh/client');
const dumps = require('../storage/dumps');
const audit = require('../storage/audit');
const logging = require('../logging');
const path = require('node:path');

// Serialize backups per-Server so we don't open two parallel SSH sessions to
// the same VPS — many sshd configs throttle that, and it can confuse
// docker-compose locking.
const inFlightByServer = new Map(); // serverId -> Promise
// Map opId → AbortController so backup:cancel can find the right one.
const abortByOp = new Map();

function register({ app, servers, targets, knownHosts, keychain, passphraseCache }) {
  ipcMain.handle('dumps:list', () => dumps.list(app));
  ipcMain.handle('audit:tail', (_e, n) => audit.tail(app, n || 50));
  ipcMain.handle('hosts:list', () => knownHosts.list());
  ipcMain.handle('hosts:revoke', (_e, { host, port }) => { knownHosts.revoke(host, port); return { ok: true }; });
  ipcMain.handle('backup:queueDepth', (_e, serverId) => (inFlightByServer.has(serverId) ? 1 : 0));

  ipcMain.handle('backup:cancel', (_e, opId) => {
    const ac = abortByOp.get(opId);
    if (!ac) return { ok: false, error: 'no such op' };
    ac.abort();
    return { ok: true };
  });

  ipcMain.handle('backup:start', async (event, { targetId, passphrase }) => {
    const opId = 'op-' + crypto.randomUUID();
    const win = BrowserWindow.fromWebContents(event.sender);
    const send = (channel, payload) => { try { win && win.webContents.send(channel, payload); } catch {} };
    const startedAt = Date.now();

    // Register the AbortController up front and announce the opId to the
    // renderer immediately, before any synchronous work or queueing. This
    // closes the cancel-before-first-progress race: if the user clicks Cancel
    // during connect, the renderer already has an opId and the backend can
    // find an AbortController to abort.
    const ac = new AbortController();
    abortByOp.set(opId, ac);
    send('backup:progress', { opId, phase: 'opening' });

    let target, server;
    try {
      target = targets._getDecrypted(targetId);
      if (target.kind !== 'docker-compose-vps') {
        throw new Error('Only docker-compose-vps backups are wired up in MVP. URI support coming next.');
      }
      server = servers.get(target.serverId);
    } catch (err) {
      abortByOp.delete(opId);
      send('backup:progress', { opId, phase: 'error', error: err.message });
      logging.error('backup', 'Cannot start backup: ' + err.message, { targetId });
      return { opId, ok: false, error: err.message };
    }

    const cl = target.vps && target.vps.compressionLevel;
    logging.info('backup', 'Starting backup of "' + target.name + '"', {
      targetId: target.id, serverId: server.id, server: server.name,
      dbName: target.dbName, service: target.vps && target.vps.service,
      compressionLevel: cl == null ? '1 (default — fast)' : cl,
    });

    // Per-server queueing.
    const prev = inFlightByServer.get(server.id);
    if (prev) {
      send('backup:progress', { opId, phase: 'queued' });
      logging.info('backup', 'Queued behind another backup on ' + server.name);
      try { await prev; } catch { /* ignore the previous op's outcome */ }
    }

    const exec = (async () => {
      try {
        const privateKey = sshClient.loadPrivateKey(server.privateKeyPath);
        const dumpKey = keychain.ensure(app);

        const effectivePass = passphrase || passphraseCache.get(server.id) || '';

        send('backup:progress', { opId, phase: 'connecting' });

        const meta = await backupVps.run({
          server,
          target,
          privateKey,
          passphrase: effectivePass || undefined,
          dumpKey,
          knownHosts,
          userDataApp: app,
          signal: ac.signal,
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
                'Only continue if this fingerprint matches the one printed by `ssh-keyscan` or your VPS provider.',
              noLink: true,
            });
            return res.response === 0;
          },
          onProgress: (p) => {
            // Route stderr lines and stall warnings to the log drawer so the
            // user can see why a backup is "stuck" without leaving the app.
            if (p && p.phase === 'stderr') {
              logging.debug('pg_dump', p.line || '', { opId, targetId: target.id });
              return; // not a UI progress phase — don't relay
            }
            if (p && p.phase === 'stalled') {
              logging.warn('backup', 'No data from pg_dump in ' + Math.round(p.idleMs / 1000) + 's', {
                opId, targetId: target.id, dbName: target.dbName,
              });
            }
            if (p && p.phase === 'resumed') {
              logging.info('backup', 'Data resumed', { opId, targetId: target.id });
            }
            send('backup:progress', { opId, ...p });
          },
        });

        // Cache the passphrase on success — only if the caller actually supplied
        // one. (If we used a cached value, it's already there.)
        if (passphrase) passphraseCache.set(server.id, passphrase);

        audit.append(app, {
          op: 'backup',
          serverId: server.id,
          serverName: server.name,
          targetId: target.id,
          profileId: target.id, // legacy field
          profileName: target.name,
          envTag: target.envTag,
          dbName: target.dbName,
          ok: true,
          durationMs: Date.now() - startedAt,
          bytesOut: meta.byteSize,
          dumpPath: meta.path,
          dumpSha256: meta.sha256Ciphertext,
        });
        send('backup:progress', { opId, phase: 'done', meta });
        logging.info('backup', 'Backup completed: ' + target.name + ' (' + meta.byteSize + ' bytes)', {
          targetId: target.id, dumpPath: meta.path, sha256: meta.sha256Ciphertext,
          durationMs: Date.now() - startedAt,
        });
        return { opId, ok: true, meta };
      } catch (err) {
        // Detect "key needs passphrase" so the renderer can prompt and retry
        // without us having to pre-flight a separate connection.test.
        const needsPassphrase = err && err.level === 'client-authentication'
          || /passphrase|encrypted|cannot parse privateKey/i.test(err && err.message || '');
        const code = needsPassphrase ? 'NEED_PASSPHRASE' : (err.code || null);
        audit.append(app, {
          op: 'backup',
          serverId: server && server.id,
          serverName: server && server.name,
          targetId: target && target.id,
          profileId: target && target.id,
          profileName: target && target.name,
          dbName: target && target.dbName,
          ok: false,
          error: err.message,
          code,
          durationMs: Date.now() - startedAt,
        });
        send('backup:progress', { opId, phase: 'error', error: err.message, code });
        logging.error('backup', 'Backup failed: ' + (target && target.name) + ' — ' + err.message, {
          targetId: target && target.id, serverId: server && server.id,
          code, stack: err.stack,
        });
        return { opId, ok: false, error: err.message, code };
      }
    })();

    inFlightByServer.set(server.id, exec);
    try {
      return await exec;
    } finally {
      if (inFlightByServer.get(server.id) === exec) inFlightByServer.delete(server.id);
      abortByOp.delete(opId);
    }
  });

  // --- Restore ---
  //
  // Mirrors backup:start: same opId, AbortController, queueing, NEED_PASSPHRASE
  // handling, and `backup:progress` event channel (so the renderer's existing
  // op-panel renders restore progress for free; the audit row uses op:'restore'
  // to distinguish in history).
  ipcMain.handle('restore:cancel', (_e, opId) => {
    const ac = abortByOp.get(opId);
    if (!ac) return { ok: false, error: 'no such op' };
    ac.abort();
    return { ok: true };
  });

  ipcMain.handle('restore:start', async (event, { dumpPath, targetId, cleanFirst, passphrase }) => {
    const opId = 'op-' + crypto.randomUUID();
    const win = BrowserWindow.fromWebContents(event.sender);
    const send = (channel, payload) => { try { win && win.webContents.send(channel, payload); } catch {} };
    const startedAt = Date.now();

    const ac = new AbortController();
    abortByOp.set(opId, ac);
    send('backup:progress', { opId, phase: 'opening', op: 'restore' });

    let target, server;
    try {
      // Caller passes either targetId (preferred — restore into a specific
      // target) or relies on the dump sidecar's sourceProfileId.
      let resolvedTargetId = targetId;
      if (!resolvedTargetId) {
        const sidecar = dumpPath + '.json';
        const meta = JSON.parse(require('node:fs').readFileSync(sidecar, 'utf8'));
        resolvedTargetId = meta.sourceProfileId || meta.targetId;
      }
      target = targets._getDecrypted(resolvedTargetId);
      if (target.kind !== 'docker-compose-vps') {
        throw new Error('Only docker-compose-vps restores are wired up in MVP.');
      }
      server = servers.get(target.serverId);
    } catch (err) {
      abortByOp.delete(opId);
      send('backup:progress', { opId, phase: 'error', error: err.message });
      logging.error('restore', 'Cannot start restore: ' + err.message, { dumpPath, targetId });
      return { opId, ok: false, error: err.message };
    }

    logging.info('restore', 'Starting restore of "' + target.name + '"', {
      targetId: target.id, serverId: server.id, server: server.name,
      dbName: target.dbName, dumpPath, cleanFirst: !!cleanFirst,
    });

    const prev = inFlightByServer.get(server.id);
    if (prev) {
      send('backup:progress', { opId, phase: 'queued' });
      logging.info('restore', 'Queued behind another op on ' + server.name);
      try { await prev; } catch { /* ignore */ }
    }

    const exec = (async () => {
      try {
        const privateKey = sshClient.loadPrivateKey(server.privateKeyPath);
        const dumpKey = keychain.ensure(app);
        const effectivePass = passphrase || passphraseCache.get(server.id) || '';

        send('backup:progress', { opId, phase: 'connecting' });

        const meta = await restoreVps.run({
          server, target,
          dumpPath, cleanFirst: !!cleanFirst,
          privateKey,
          passphrase: effectivePass || undefined,
          dumpKey,
          knownHosts,
          signal: ac.signal,
          onUntrustedHost: async ({ host, port, fingerprint, keyType }) => {
            const res = await dialog.showMessageBox(win, {
              type: 'warning',
              buttons: ['Trust and continue', 'Cancel'],
              defaultId: 1, cancelId: 1,
              title: 'Unknown SSH host',
              message: 'Trust ' + host + ':' + port + '?',
              detail: 'This host has not been seen before.\n\n' + keyType + ' fingerprint:\n' + fingerprint,
              noLink: true,
            });
            return res.response === 0;
          },
          onProgress: (p) => {
            if (p && p.phase === 'stderr') {
              logging.debug('pg_restore', p.line || '', { opId, targetId: target.id });
              return;
            }
            if (p && p.phase === 'stalled') {
              logging.warn('restore', 'No data accepted by pg_restore in ' + Math.round(p.idleMs / 1000) + 's',
                { opId, targetId: target.id });
            }
            send('backup:progress', { opId, ...p });
          },
        });

        if (passphrase) passphraseCache.set(server.id, passphrase);

        audit.append(app, {
          op: 'restore',
          serverId: server.id, serverName: server.name,
          targetId: target.id, profileId: target.id, profileName: target.name,
          envTag: target.envTag, dbName: target.dbName,
          ok: true, durationMs: Date.now() - startedAt,
          bytesIn: meta.bytesIn, dumpPath, cleanFirst: !!cleanFirst,
        });
        send('backup:progress', { opId, phase: 'done', meta });
        logging.info('restore', 'Restore completed: ' + target.name + ' (' + meta.bytesIn + ' bytes)', {
          targetId: target.id, durationMs: Date.now() - startedAt,
        });
        return { opId, ok: true, meta };
      } catch (err) {
        const needsPassphrase = err && err.level === 'client-authentication'
          || /passphrase|encrypted|cannot parse privateKey/i.test(err && err.message || '');
        const code = needsPassphrase ? 'NEED_PASSPHRASE' : (err.code || null);
        audit.append(app, {
          op: 'restore',
          serverId: server && server.id, serverName: server && server.name,
          targetId: target && target.id, profileId: target && target.id,
          profileName: target && target.name, dbName: target && target.dbName,
          ok: false, error: err.message, code,
          durationMs: Date.now() - startedAt,
        });
        send('backup:progress', { opId, phase: 'error', error: err.message, code });
        logging.error('restore', 'Restore failed: ' + (target && target.name) + ' — ' + err.message, {
          targetId: target && target.id, code, stack: err.stack,
        });
        return { opId, ok: false, error: err.message, code };
      }
    })();

    inFlightByServer.set(server.id, exec);
    try {
      return await exec;
    } finally {
      if (inFlightByServer.get(server.id) === exec) inFlightByServer.delete(server.id);
      abortByOp.delete(opId);
    }
  });
}

module.exports = { register };
