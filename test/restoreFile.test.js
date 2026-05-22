'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectFileFormat } = require('../src/main/ops/restoreFile');

// --- detectFileFormat ---

test('detectFileFormat: .sql → sql', () => {
  assert.equal(detectFileFormat('/backups/dump.sql'), 'sql');
});

test('detectFileFormat: .SQL uppercase → sql', () => {
  assert.equal(detectFileFormat('/backups/dump.SQL'), 'sql');
});

test('detectFileFormat: .pgdump → pgdump', () => {
  assert.equal(detectFileFormat('/backups/dump.pgdump'), 'pgdump');
});

test('detectFileFormat: .dump → pgdump', () => {
  assert.equal(detectFileFormat('/backups/mydb.dump'), 'pgdump');
});

test('detectFileFormat: .archive → archive', () => {
  assert.equal(detectFileFormat('/backups/mongo.archive'), 'archive');
});

test('detectFileFormat: .ARCHIVE uppercase → archive', () => {
  assert.equal(detectFileFormat('/backups/mongo.ARCHIVE'), 'archive');
});

test('detectFileFormat: unknown extension falls back to pgdump', () => {
  assert.equal(detectFileFormat('/backups/export.bin'), 'pgdump');
});

test('detectFileFormat: no extension falls back to pgdump', () => {
  assert.equal(detectFileFormat('/backups/dumpfile'), 'pgdump');
});

test('detectFileFormat: path with dots in directory still reads last extension', () => {
  assert.equal(detectFileFormat('/my.dir/backups/appdb.sql'), 'sql');
  assert.equal(detectFileFormat('/my.dir/backups/appdb.archive'), 'archive');
  assert.equal(detectFileFormat('/my.dir/backups/appdb.pgdump'), 'pgdump');
});

test('detectFileFormat: Windows-style backslash path', () => {
  assert.equal(detectFileFormat('C:\\Users\\user\\dumps\\db.sql'), 'sql');
  assert.equal(detectFileFormat('C:\\Users\\user\\dumps\\db.pgdump'), 'pgdump');
  assert.equal(detectFileFormat('C:\\Users\\user\\dumps\\db.archive'), 'archive');
});
