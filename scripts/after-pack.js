'use strict';

const fs = require('node:fs');
const path = require('node:path');

// electron-builder afterPack hook — restores the SUID bit on chrome-sandbox
// for Linux builds. Without 4755, Electron silently exits on Ubuntu 23.10+
// because kernel.apparmor_restrict_unprivileged_userns=1 blocks the namespace
// sandbox, and the SUID sandbox helper is the only working fallback.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const sandbox = path.join(context.appOutDir, 'chrome-sandbox');
  if (!fs.existsSync(sandbox)) return;
  // 4755 = setuid + rwxr-xr-x. Owner becomes root at .deb install time via fpm.
  fs.chmodSync(sandbox, 0o4755);
};
