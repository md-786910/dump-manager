'use strict';

const { ipcMain } = require('electron');

function register({ targets }) {
  ipcMain.handle('targets:list', () => targets.list());
  ipcMain.handle('targets:create', (_e, input) => targets.create(input));
  ipcMain.handle('targets:createMany', (_e, inputs) => targets.createMany(inputs));
  ipcMain.handle('targets:update', (_e, { id, patch }) => targets.update(id, patch));
  ipcMain.handle('targets:delete', (_e, id) => { targets.remove(id); return { ok: true }; });
  ipcMain.handle('targets:listByServer', (_e, serverId) => targets.listByServer(serverId));
  ipcMain.handle('targets:existingDbsForServer', (_e, serverId) => targets.existingDbsForServer(serverId));
}

module.exports = { register };
