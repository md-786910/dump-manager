'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settings = require('../src/main/storage/settings');

function mkApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbm-settings-'));
  return {
    dir,
    getPath: (name) => {
      if (name !== 'userData') throw new Error('unexpected getPath: ' + name);
      return dir;
    },
  };
}

test('returns undefined for unset keys', () => {
  const app = mkApp();
  assert.equal(settings.get(app, 'dumpsDir'), undefined);
  assert.deepEqual(settings.all(app), {});
});

test('set then get roundtrip persists to disk', () => {
  const app = mkApp();
  settings.set(app, 'dumpsDir', '/some/path');
  assert.equal(settings.get(app, 'dumpsDir'), '/some/path');

  // Verify it actually wrote to settings.json
  const raw = fs.readFileSync(path.join(app.dir, 'settings.json'), 'utf8');
  assert.deepEqual(JSON.parse(raw), { dumpsDir: '/some/path' });
});

test('set with undefined deletes the key', () => {
  const app = mkApp();
  settings.set(app, 'dumpsDir', '/p');
  settings.set(app, 'other', 42);
  settings.set(app, 'dumpsDir', undefined);
  assert.deepEqual(settings.all(app), { other: 42 });
});

test('survives a corrupt settings.json (returns empty)', () => {
  const app = mkApp();
  fs.writeFileSync(path.join(app.dir, 'settings.json'), '{not-json');
  assert.deepEqual(settings.all(app), {});
  assert.equal(settings.get(app, 'anything'), undefined);
});

test('atomic write uses .tmp + rename', () => {
  const app = mkApp();
  settings.set(app, 'dumpsDir', '/x');
  // After a successful write, no .tmp file should remain.
  const files = fs.readdirSync(app.dir);
  assert.ok(files.includes('settings.json'));
  assert.ok(!files.includes('settings.json.tmp'));
});
