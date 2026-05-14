'use strict';

const { ipcMain } = require('electron');

const channel = require('../exec/channel');
const dbViewer = require('../ops/dbViewer');
const sshClient = require('../ssh/client');
const logging = require('../logging');

function register({ servers, targets, knownHosts, passphraseCache }) {
  ipcMain.handle('db:listTables', async (_event, { targetId, passphrase }) => {
    let target, server;
    try {
      target = targets._getDecrypted(targetId);
      server = target.serverId ? servers.get(target.serverId) : null;
    } catch (err) {
      return { ok: false, error: err.message };
    }

    let ch;
    try {
      ch = await _openChannel(server, passphrase, passphraseCache, knownHosts);
      const tables = await dbViewer.listTables(ch, target);
      if (passphrase && server && server.kind === 'ssh') passphraseCache.set(server.id, passphrase);
      logging.debug('dbViewer', 'Listed ' + tables.length + ' table(s) for target ' + target.name);
      return { ok: true, tables };
    } catch (err) {
      logging.warn('dbViewer', 'listTables failed for ' + (target && target.name) + ': ' + err.message);
      return { ok: false, error: err.message, code: err.code || null };
    } finally {
      if (ch) try { ch.end(); } catch {}
    }
  });

  ipcMain.handle('db:queryTable', async (_event, { targetId, schema, table, offset, passphrase }) => {
    let target, server;
    try {
      target = targets._getDecrypted(targetId);
      server = target.serverId ? servers.get(target.serverId) : null;
    } catch (err) {
      return { ok: false, error: err.message };
    }

    let ch;
    try {
      ch = await _openChannel(server, passphrase, passphraseCache, knownHosts);
      const result = await dbViewer.queryTable(ch, target, { schema, table, offset: offset || 0 });
      if (passphrase && server && server.kind === 'ssh') passphraseCache.set(server.id, passphrase);
      return { ok: true, ...result };
    } catch (err) {
      logging.warn('dbViewer', 'queryTable failed for ' + (target && target.name) + ': ' + err.message);
      return { ok: false, error: err.message, code: err.code || null };
    } finally {
      if (ch) try { ch.end(); } catch {}
    }
  });

  ipcMain.handle('db:listCollections', async (_event, { targetId, passphrase }) => {
    let target, server;
    try {
      target = targets._getDecrypted(targetId);
      server = target.serverId ? servers.get(target.serverId) : null;
    } catch (err) {
      return { ok: false, error: err.message };
    }
    let ch;
    try {
      ch = await _openChannel(server, passphrase, passphraseCache, knownHosts);
      const collections = await dbViewer.listCollections(ch, target);
      if (passphrase && server && server.kind === 'ssh') passphraseCache.set(server.id, passphrase);
      logging.debug('dbViewer', 'Listed ' + collections.length + ' collection(s) for target ' + target.name);
      return { ok: true, collections };
    } catch (err) {
      logging.warn('dbViewer', 'listCollections failed for ' + (target && target.name) + ': ' + err.message);
      return { ok: false, error: err.message, code: err.code || null };
    } finally {
      if (ch) try { ch.end(); } catch {}
    }
  });

  ipcMain.handle('db:queryCollection', async (_event, { targetId, collection, offset, passphrase }) => {
    let target, server;
    try {
      target = targets._getDecrypted(targetId);
      server = target.serverId ? servers.get(target.serverId) : null;
    } catch (err) {
      return { ok: false, error: err.message };
    }
    let ch;
    try {
      ch = await _openChannel(server, passphrase, passphraseCache, knownHosts);
      const result = await dbViewer.queryCollection(ch, target, { collection, offset: offset || 0 });
      if (passphrase && server && server.kind === 'ssh') passphraseCache.set(server.id, passphrase);
      return { ok: true, ...result };
    } catch (err) {
      logging.warn('dbViewer', 'queryCollection failed for ' + (target && target.name) + ': ' + err.message);
      return { ok: false, error: err.message, code: err.code || null };
    } finally {
      if (ch) try { ch.end(); } catch {}
    }
  });

  ipcMain.handle('db:listDatabases', async (_event, { targetId, passphrase }) => {
    let target, server;
    try {
      target = targets._getDecrypted(targetId);
      server = target.serverId ? servers.get(target.serverId) : null;
    } catch (err) {
      return { ok: false, error: err.message };
    }

    let ch;
    try {
      ch = await _openChannel(server, passphrase, passphraseCache, knownHosts);
      const databases = await dbViewer.listDatabases(ch, target);
      if (passphrase && server && server.kind === 'ssh') passphraseCache.set(server.id, passphrase);
      logging.debug('dbViewer', 'Listed ' + databases.length + ' database(s) for target ' + target.name);
      return { ok: true, databases };
    } catch (err) {
      logging.warn('dbViewer', 'listDatabases failed for ' + (target && target.name) + ': ' + err.message);
      return { ok: false, error: err.message, code: err.code || null };
    } finally {
      if (ch) try { ch.end(); } catch {}
    }
  });
}

async function _openChannel(server, passphrase, passphraseCache, knownHosts) {
  if (!server || server.kind === 'local' || server.kind === undefined) {
    return channel.connect(server || null, {});
  }
  const privateKey = sshClient.loadPrivateKey(server.privateKeyPath);
  const effectivePass = passphrase || passphraseCache.get(server.id) || '';
  return channel.connect(server, {
    privateKey,
    passphrase: effectivePass || undefined,
    knownHosts,
  });
}

module.exports = { register };
