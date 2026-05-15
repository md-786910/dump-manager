'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'app:ping',
  'servers:list', 'servers:create', 'servers:update', 'servers:delete',
  'targets:list', 'targets:create', 'targets:createMany', 'targets:update', 'targets:delete',
  'targets:listByServer', 'targets:existingDbsForServer', 'targets:getUri',
  'dumps:list', 'dumps:delete', 'dumps:download',
  'audit:tail',
  'hosts:list', 'hosts:revoke',
  'backup:start', 'backup:cancel', 'backup:queueDepth',
  'restore:start', 'restore:cancel',
  'discovery:run',
  'connection:test', 'connection:disconnect', 'connection:status', 'connection:statusAll',
  'compose:listProjects',
  'logs:tail', 'logs:append',
  'dialog:pickKeyFile', 'dialog:confirm', 'wsl:listDistros',
  'settings:get', 'settings:ensureDumpsDir', 'settings:pickDumpsDir',
  'db:listTables', 'db:queryTable', 'db:listDatabases', 'db:listCollections', 'db:queryCollection',
  'privacy:accept',
  'update:check', 'update:installNow',
]);

const RECV_CHANNELS = new Set([
  'backup:progress',
  'discovery:progress',
  'log:event',
  'show:privacy',
  'update:checking', 'update:available', 'update:none',
  'update:progress', 'update:ready', 'update:error',
]);

function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(new Error('ipc channel not allowed: ' + channel));
  }
  return ipcRenderer.invoke(channel, payload);
}

function on(channel, listener) {
  if (!RECV_CHANNELS.has(channel)) throw new Error('event channel not allowed: ' + channel);
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('dbm', {
  ping: () => invoke('app:ping'),
  servers: {
    list: () => invoke('servers:list'),
    create: (input) => invoke('servers:create', input),
    update: (id, patch) => invoke('servers:update', { id, patch }),
    remove: (id, cascade) => invoke('servers:delete', { id, cascade: !!cascade }),
  },
  targets: {
    list: () => invoke('targets:list'),
    create: (input) => invoke('targets:create', input),
    createMany: (inputs) => invoke('targets:createMany', inputs),
    update: (id, patch) => invoke('targets:update', { id, patch }),
    remove: (id) => invoke('targets:delete', id),
    listByServer: (serverId) => invoke('targets:listByServer', serverId),
    existingDbsForServer: (serverId) => invoke('targets:existingDbsForServer', serverId),
    getUri: (id) => invoke('targets:getUri', id),
  },
  dumps: {
    list: () => invoke('dumps:list'),
    remove: (dumpPath) => invoke('dumps:delete', dumpPath),
    download: (dumpPath) => invoke('dumps:download', { dumpPath }),
  },
  restore: {
    start: (dumpPath, opts) => invoke('restore:start', { dumpPath, ...(opts || {}) }),
    cancel: (opId) => invoke('restore:cancel', opId),
  },
  settings: {
    get: (key) => invoke('settings:get', key),
    ensureDumpsDir: () => invoke('settings:ensureDumpsDir'),
    pickDumpsDir: (opts) => invoke('settings:pickDumpsDir', opts || {}),
  },
  audit: { tail: (n) => invoke('audit:tail', n) },
  hosts: {
    list: () => invoke('hosts:list'),
    revoke: (host, port) => invoke('hosts:revoke', { host, port }),
  },
  backup: {
    start: (targetId, passphrase) => invoke('backup:start', { targetId, passphrase }),
    cancel: (opId) => invoke('backup:cancel', opId),
    queueDepth: (serverId) => invoke('backup:queueDepth', serverId),
    onProgress: (listener) => on('backup:progress', listener),
  },
  discovery: {
    run: (serverId, passphrase) => invoke('discovery:run', { serverId, passphrase }),
    onProgress: (listener) => on('discovery:progress', listener),
  },
  connection: {
    test: (serverId, passphrase) => invoke('connection:test', { serverId, passphrase }),
    disconnect: (serverId) => invoke('connection:disconnect', serverId),
    status: (serverId) => invoke('connection:status', serverId),
    statusAll: () => invoke('connection:statusAll'),
  },
  compose: {
    listProjects: (serverId, passphrase) => invoke('compose:listProjects', { serverId, passphrase }),
  },
  logs: {
    tail: (n) => invoke('logs:tail', n),
    append: (entry) => invoke('logs:append', entry),
    onEvent: (listener) => on('log:event', listener),
  },
  dialog: {
    pickKeyFile: () => invoke('dialog:pickKeyFile'),
    confirm: (opts) => invoke('dialog:confirm', opts || {}),
  },
  wsl: {
    listDistros: () => invoke('wsl:listDistros'),
  },
  db: {
    listTables: (targetId, passphrase) => invoke('db:listTables', { targetId, passphrase }),
    queryTable: (targetId, schema, table, offset, passphrase) =>
      invoke('db:queryTable', { targetId, schema, table, offset, passphrase }),
    listDatabases: (targetId, passphrase) => invoke('db:listDatabases', { targetId, passphrase }),
    listCollections: (targetId, passphrase) => invoke('db:listCollections', { targetId, passphrase }),
    queryCollection: (targetId, collection, offset, passphrase) =>
      invoke('db:queryCollection', { targetId, collection, offset, passphrase }),
  },
  privacy: {
    accept: () => invoke('privacy:accept'),
    onShow: (listener) => on('show:privacy', listener),
  },
  updates: {
    check: () => invoke('update:check'),
    installNow: () => invoke('update:installNow'),
    on: (event, listener) => {
      const channel = 'update:' + event;
      if (!RECV_CHANNELS.has(channel)) throw new Error('unknown update event: ' + event);
      return on(channel, listener);
    },
  },
});
