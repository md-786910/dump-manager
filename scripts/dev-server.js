'use strict';

// Tiny static server for src/renderer/ — Node built-ins only, no deps.
// Used by `npm run dev:web` to iterate on the UI in a regular browser with
// a mocked window.dbm (see src/renderer/dev-mock.js).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'src', 'renderer');
const PORT = Number(process.env.PORT) || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.resolve(ROOT, '.' + safePath);

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403); return res.end('forbidden');
  }

  fs.stat(filePath, (statErr, st) => {
    if (statErr || !st.isFile()) { res.writeHead(404); return res.end('not found: ' + urlPath); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('dbManager dev server: http://localhost:' + PORT);
  console.log('  serving: ' + ROOT);
  console.log('  the renderer uses src/renderer/dev-mock.js as a stand-in for the Electron preload bridge.');
});
