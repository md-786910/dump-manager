'use strict';

const { ipcMain, dialog, BrowserWindow } = require('electron');
const os = require('node:os');
const path = require('node:path');

function register() {
  ipcMain.handle('dialog:pickKeyFile', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const sshDir = path.join(os.homedir(), '.ssh');
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose SSH private key',
      defaultPath: sshDir,
      buttonLabel: 'Use key',
      filters: [
        { name: 'SSH keys', extensions: ['pem', 'key', 'ppk', 'rsa', 'ed25519', 'dsa', 'ecdsa'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile', 'showHiddenFiles', 'dontAddToRecent'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });
}

module.exports = { register };
