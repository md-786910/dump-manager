'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const logging = require('../logging');

function register() {
  ipcMain.handle('logs:tail', (_e, n) => logging.tail(n));

  // Capture log events from the renderer too (window.onerror, unhandled
  // rejections, manual app log calls).
  ipcMain.handle('logs:append', (_e, { level, component, message, details }) => {
    logging.log(level || 'info', component || 'renderer', message, details);
    return { ok: true };
  });

  // Broadcast every entry to every open window. Subscribers are kept for the
  // lifetime of the process — that's fine, we have at most a handful of windows.
  logging.subscribe((entry) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try { win.webContents.send('log:event', entry); } catch { /* renderer gone */ }
    }
  });
}

module.exports = { register };
