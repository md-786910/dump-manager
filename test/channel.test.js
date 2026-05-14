'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const channel = require('../src/main/exec/channel');

test('local channel: exec echo returns stdout + exit 0', async () => {
  const ch = await channel.connect(null);
  assert.equal(ch.kind, 'local');

  const stream = await ch.exec(process.platform === 'win32' ? 'echo hi' : 'echo hi');
  const { stdout, exitCode } = await new Promise((resolve, reject) => {
    let out = '', code = null;
    stream.on('data', (c) => { out += c.toString('utf8'); });
    stream.on('exit', (c) => { code = c; });
    stream.on('close', () => resolve({ stdout: out, exitCode: code }));
    stream.on('error', reject);
  });
  ch.end();
  assert.match(stdout, /hi/);
  assert.equal(exitCode, 0);
});

test('local channel: env var is passed to the spawned shell', async () => {
  const ch = await channel.connect({ kind: 'local', name: 'test' });
  const cmd = process.platform === 'win32'
    ? 'echo %MYVAR%'
    : 'echo "$MYVAR"';
  const stream = await ch.exec(cmd, { env: { MYVAR: 'hello-from-test' } });
  const stdout = await new Promise((resolve, reject) => {
    let out = '';
    stream.on('data', (c) => { out += c.toString('utf8'); });
    stream.on('close', () => resolve(out));
    stream.on('error', reject);
  });
  ch.end();
  assert.match(stdout, /hello-from-test/);
});

test('local channel: non-zero exit code is surfaced', async () => {
  const ch = await channel.connect(null);
  const cmd = process.platform === 'win32' ? 'exit 7' : 'exit 7';
  const stream = await ch.exec(cmd);
  const exitCode = await new Promise((resolve, reject) => {
    let code = null;
    stream.on('exit', (c) => { code = c; });
    stream.on('close', () => resolve(code));
    stream.on('error', reject);
  });
  ch.end();
  assert.equal(exitCode, 7);
});
