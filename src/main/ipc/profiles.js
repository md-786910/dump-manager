'use strict';

const { ipcMain } = require('electron');

function register({ profiles }) {
  ipcMain.handle('profiles:list', () => profiles.list());
  ipcMain.handle('profiles:create', (_e, input) => profiles.create(input));
  ipcMain.handle('profiles:update', (_e, { id, patch }) => profiles.update(id, patch));
  ipcMain.handle('profiles:delete', (_e, id) => { profiles.remove(id); return { ok: true }; });
}

module.exports = { register };
