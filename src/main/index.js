'use strict';

const { app, BrowserWindow, Menu, ipcMain, safeStorage, shell } = require('electron');
const path = require('node:path');

const migrate = require('./storage/migrate');
const serversStore = require('./storage/servers');
const targetsStore = require('./storage/targets');
const knownHostsStore = require('./ssh/knownHosts');
const passphraseCache = require('./ssh/passphraseCache');
const keychain = require('./crypto/keychain');
const audit = require('./storage/audit');

const settings = require('./storage/settings');

const ipcServers = require('./ipc/servers');
const ipcTargets = require('./ipc/targets');
const ipcBackup = require('./ipc/backup');
const ipcDiscovery = require('./ipc/discovery');
const ipcDialog = require('./ipc/dialog');
const ipcDumps = require('./ipc/dumps');
const ipcLogs = require('./ipc/logs');
const ipcDbViewer = require('./ipc/dbViewer');
const logging = require('./logging');

const isDev = !app.isPackaged;
const autoOpenDevTools = process.env.TUNNEX_DEV === '1' || process.env.DBM_DEV === '1';

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0F1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev,
    },
  });

  win.once('ready-to-show', () => {
    if (!settings.get(app, 'privacyAccepted')) {
      win.webContents.send('show:privacy');
    }
    win.show();
    if (autoOpenDevTools) win.webContents.openDevTools({ mode: 'detach' });
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    const here = new URL(win.webContents.getURL());
    if (target.origin !== here.origin) event.preventDefault();
  });

  return win;
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.whenReady().then(() => {
  // Drop the default OS menu (File / Edit / View / Help). The app is fully
  // driven from the in-window UI; the native menu only adds visual noise.
  Menu.setApplicationMenu(null);

  // 0. Initialize logging before anything else so the migration step itself
  //    can emit log entries.
  logging.init(app);
  logging.info('app', 'Tunnex started', {
    electron: process.versions.electron, node: process.versions.node, platform: process.platform,
  });

  // 1. Run the one-shot legacy migration BEFORE any storage API is built.
  try {
    const result = migrate.run(app);
    if (result.migrated) {
      logging.info('migrate', 'Migrated legacy profiles', {
        servers: result.serverCount, targets: result.targetCount,
      });
    } else if (result.reason) {
      logging.debug('migrate', 'Skipped migration: ' + result.reason);
    }
  } catch (err) {
    logging.error('migrate', err.message, { stack: err.stack });
  }

  // 2. Build stores + register IPC.
  const servers = serversStore.buildApi(app);
  const targets = targetsStore.buildApi(app, safeStorage);
  const knownHosts = knownHostsStore.buildApi(app);

  // Stamp `kind: 'ssh'` onto any legacy server record that predates the
  // local-vs-ssh split. Idempotent — re-running is a no-op.
  try {
    for (const s of servers.list()) {
      if (!s.kind) servers.update(s.id, { kind: 'ssh' });
    }
  } catch (err) {
    logging.error('migrate', 'kind backfill failed: ' + err.message);
  }

  passphraseCache.attach(app);

  ipcMain.handle('privacy:accept', () => {
    settings.set(app, 'privacyAccepted', true);
    return { ok: true };
  });

  ipcMain.handle('app:ping', () => ({
    ok: true,
    runtime: {
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      packaged: app.isPackaged,
      safeStorageAvailable: safeStorage.isEncryptionAvailable(),
    },
  }));

  ipcServers.register({ servers, targets, knownHosts, passphraseCache, audit, app });
  ipcTargets.register({ targets });
  ipcBackup.register({ app, servers, targets, knownHosts, keychain, passphraseCache });
  ipcDiscovery.register({ servers, knownHosts, passphraseCache, audit, app });
  ipcDialog.register();
  ipcDumps.register({ app, keychain });
  ipcLogs.register();
  ipcDbViewer.register({ servers, targets, knownHosts, passphraseCache });

  const mainWin = createMainWindow();

  // Auto-update is only meaningful for packaged builds — the dev tree has no
  // installed binary to swap out. Skipping silently in dev avoids noisy logs.
  if (app.isPackaged) {
    try {
      require('./updater').attach(mainWin);
    } catch (err) {
      logging.warn('updater', 'failed to attach: ' + err.message);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
