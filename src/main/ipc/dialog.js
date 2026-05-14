'use strict';

const { ipcMain, dialog, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function register() {
  // List WSL distros (Windows only). Returns [{ name, isDefault }] on success.
  // On non-Windows, returns []. Errors (no WSL installed, etc.) → empty list
  // + an error field so the renderer can show a hint.
  ipcMain.handle('wsl:listDistros', () => listWslDistros());
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

function listWslDistros() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ distros: [] });
    // `wsl --list --verbose` would give status too, but its UTF-16 output is
    // harder to parse reliably. `--list --quiet` returns one distro per line.
    const child = spawn('wsl.exe', ['--list', '--quiet'], { windowsHide: true });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => resolve({ distros: [], error: 'wsl.exe not found' }));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ distros: [], error: 'wsl --list exited ' + code });
      // wsl.exe writes UTF-16 LE with a BOM by default.
      const buf = Buffer.concat(chunks);
      let text;
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        text = buf.slice(2).toString('utf16le');
      } else {
        text = buf.toString('utf16le');
      }
      // Strip nulls, CR, and trim. Lines that are blank or just whitespace skip.
      const lines = text.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()).filter(Boolean);
      // The default distro is marked with " (Default)" in --verbose; --quiet
      // just lists names so we have no default info here. Fine for a picker.
      resolve({ distros: lines.map((name) => ({ name })) });
    });
  });
}

module.exports = { register };
