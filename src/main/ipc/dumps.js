'use strict';

// IPC handlers for dump-list actions (delete / download) and the small
// dialog-confirmation helper used by destructive UI flows.

const { ipcMain, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const dumps = require('../storage/dumps');
const settings = require('../storage/settings');
const audit = require('../storage/audit');
const logging = require('../logging');
const { DecryptStream } = require('../crypto/stream');

function register({ app, keychain }) {
  // Generic confirmation modal — the renderer asks the main process to
  // present a native dialog because it gives us a destructive default button
  // style on Windows/macOS, which browser confirm() can't.
  ipcMain.handle('dialog:confirm', async (event, { title, message, detail, danger, confirmLabel, cancelLabel }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showMessageBox(win, {
      type: danger ? 'warning' : 'question',
      buttons: [confirmLabel || 'OK', cancelLabel || 'Cancel'],
      defaultId: danger ? 1 : 0,
      cancelId: 1,
      title: title || 'Confirm',
      message: message || 'Are you sure?',
      detail: detail || undefined,
      noLink: true,
    });
    return { ok: res.response === 0 };
  });

  // Delete a dump file + its sidecar. Path is validated to live inside the
  // configured dump dir to prevent the renderer from passing arbitrary paths.
  ipcMain.handle('dumps:delete', (_event, dumpPath) => {
    const root = path.resolve(dumps.dumpDir(app));
    const target = path.resolve(dumpPath || '');
    if (!target.startsWith(root + path.sep) && target !== root) {
      const err = 'refusing to delete path outside dump dir';
      logging.warn('dumps', err, { dumpPath, root });
      return { ok: false, error: err };
    }
    try {
      dumps.remove(target);
      audit.append(app, { op: 'delete-dump', dumpPath: target, ok: true });
      logging.info('dumps', 'Deleted dump', { dumpPath: target });
      return { ok: true };
    } catch (err) {
      audit.append(app, { op: 'delete-dump', dumpPath: target, ok: false, error: err.message });
      logging.error('dumps', 'Delete failed: ' + err.message, { dumpPath: target });
      return { ok: false, error: err.message };
    }
  });

  // Save a decrypted copy of the dump to a user-chosen path.
  ipcMain.handle('dumps:download', async (event, { dumpPath }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const root = path.resolve(dumps.dumpDir(app));
    const src = path.resolve(dumpPath || '');
    if (!src.startsWith(root + path.sep) && src !== root) {
      return { ok: false, error: 'refusing to read path outside dump dir' };
    }

    const base = path.basename(src).replace(/\.pgdump\.enc$/, '.pgdump');
    const res = await dialog.showSaveDialog(win, {
      title: 'Save decrypted dump as',
      defaultPath: base,
      filters: [
        { name: 'pg_dump custom format', extensions: ['pgdump', 'dump'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true };

    const startedAt = Date.now();
    try {
      const key = keychain.ensure(app);
      await pipeline(
        fs.createReadStream(src),
        new DecryptStream(key),
        fs.createWriteStream(res.filePath, { mode: 0o600 }),
      );
      audit.append(app, {
        op: 'download-dump', dumpPath: src, outPath: res.filePath,
        ok: true, durationMs: Date.now() - startedAt,
      });
      logging.info('dumps', 'Decrypted dump saved', { src, outPath: res.filePath });
      return { ok: true, outPath: res.filePath };
    } catch (err) {
      try { if (fs.existsSync(res.filePath)) fs.unlinkSync(res.filePath); } catch {}
      audit.append(app, {
        op: 'download-dump', dumpPath: src, ok: false,
        error: err.message, durationMs: Date.now() - startedAt,
      });
      logging.error('dumps', 'Decrypt failed: ' + err.message, { src });
      return { ok: false, error: err.message };
    }
  });

  // --- settings ---

  ipcMain.handle('settings:get', (_event, key) => {
    if (key === undefined) return settings.all(app);
    return { [key]: settings.get(app, key) };
  });

  // First-run guard: if dumpsDir is set, return it. Otherwise prompt the user
  // to pick one. Cancellation falls back to <userData>/dumps for this session
  // without persisting — we'll re-ask next launch.
  ipcMain.handle('settings:ensureDumpsDir', async (event) => {
    const existing = settings.get(app, 'dumpsDir');
    if (existing) {
      try { fs.mkdirSync(existing, { recursive: true }); } catch {}
      return { dumpsDir: existing, picked: false };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose where Tunnex stores dumps',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (res.canceled || !res.filePaths.length) {
      return { dumpsDir: dumps.dumpDir(app), picked: false };
    }
    const picked = res.filePaths[0];
    fs.mkdirSync(picked, { recursive: true });
    settings.set(app, 'dumpsDir', picked);
    logging.info('settings', 'Dumps folder set', { dumpsDir: picked });
    return { dumpsDir: picked, picked: true };
  });

  // Change folder. The renderer is responsible for asking the user *whether*
  // to migrate existing dumps; this handler just performs the move if asked.
  ipcMain.handle('settings:pickDumpsDir', async (event, { migrate: doMigrate }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const current = settings.get(app, 'dumpsDir') || dumps.dumpDir(app);
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose where Tunnex stores dumps',
      defaultPath: current,
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
    const picked = res.filePaths[0];
    if (picked === current) return { ok: true, dumpsDir: picked, migrated: null };

    fs.mkdirSync(picked, { recursive: true });
    let migrated = null;
    if (doMigrate) {
      migrated = dumps.migrate(current, picked);
      logging.info('settings', 'Migrated dumps', { from: current, to: picked, ...migrated });
    }
    settings.set(app, 'dumpsDir', picked);
    return { ok: true, dumpsDir: picked, previous: current, migrated };
  });
}

module.exports = { register };
