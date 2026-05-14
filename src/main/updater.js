'use strict';

// Auto-update glue for the renderer. electron-updater reads the `publish` block
// from electron-builder.yml at build time, then polls <publish.url>/latest*.yml
// at runtime over plain HTTPS — works with any static host (Cloudflare R2 here).
//
// UX: silent background download, then a non-blocking banner in the renderer
// when a build is ready to install. The renderer triggers the actual quit-and-
// install via the `update:installNow` IPC handler registered below.

const { ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const logging = require('./logging');

let attached = false;

function attach(win) {
  if (attached) return;
  attached = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => logging.info('updater', String(m)),
    warn: (m) => logging.warn('updater', String(m)),
    error: (m) => logging.error('updater', String(m)),
    debug: (m) => logging.debug('updater', String(m)),
  };

  const send = (channel, payload) => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload || null);
    } catch { /* renderer torn down — drop the event */ }
  };

  autoUpdater.on('checking-for-update', () => send('update:checking'));
  autoUpdater.on('update-available', (info) => send('update:available', { version: info.version }));
  autoUpdater.on('update-not-available', () => send('update:none'));
  autoUpdater.on('error', (err) => send('update:error', { message: err && err.message ? err.message : String(err) }));
  autoUpdater.on('download-progress', (p) => send('update:progress', {
    percent: p.percent,
    bytesPerSecond: p.bytesPerSecond,
    transferred: p.transferred,
    total: p.total,
  }));
  autoUpdater.on('update-downloaded', (info) => send('update:ready', { version: info.version }));

  ipcMain.handle('update:check', async () => {
    try { await autoUpdater.checkForUpdates(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('update:installNow', () => {
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });

  // First check shortly after the window is interactive, then hourly.
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4000);
  setInterval(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 60 * 60 * 1000);
}

module.exports = { attach };
