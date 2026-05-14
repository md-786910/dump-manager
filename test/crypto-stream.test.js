'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PassThrough, pipeline, Readable } = require('node:stream');
const { promisify } = require('node:util');
const pipe = promisify(pipeline);

const { EncryptStream, DecryptStream, HEADER_LEN, TAG_LEN } = require('../src/main/crypto/stream');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function roundTrip(plain, key) {
  const enc = new EncryptStream(key);
  const dec = new DecryptStream(key);
  const collect = [];
  const sink = new PassThrough();
  sink.on('data', (c) => collect.push(c));
  const done = new Promise((res, rej) => { sink.on('end', res); sink.on('error', rej); });
  await pipe(Readable.from(plain), enc, dec, sink);
  await done;
  return Buffer.concat(collect);
}

test('round-trips a small payload', async () => {
  const key = crypto.randomBytes(32);
  const plain = Buffer.from('hello world — é ç 中文 — and some \x00 bytes');
  const out = await roundTrip([plain], key);
  assert.equal(sha256(out), sha256(plain));
});

test('round-trips a 16 MiB random payload through many chunks', async () => {
  const key = crypto.randomBytes(32);
  const total = 16 * 1024 * 1024;
  const plain = crypto.randomBytes(total);
  // Feed in irregular chunk sizes to stress the tail-buffering in DecryptStream.
  const chunks = [];
  let off = 0;
  while (off < total) {
    const n = Math.min(total - off, 1 + Math.floor(Math.random() * 65536));
    chunks.push(plain.slice(off, off + n));
    off += n;
  }
  const out = await roundTrip(chunks, key);
  assert.equal(out.length, total);
  assert.equal(sha256(out), sha256(plain));
});

test('round-trips an empty payload', async () => {
  const key = crypto.randomBytes(32);
  const out = await roundTrip([], key);
  assert.equal(out.length, 0);
});

test('rejects wrong key', async () => {
  const k1 = crypto.randomBytes(32);
  const k2 = crypto.randomBytes(32);
  const plain = crypto.randomBytes(2048);
  const enc = new EncryptStream(k1);
  const cipherBufs = [];
  await pipe(Readable.from([plain]), enc, async function* (src) {
    for await (const c of src) { cipherBufs.push(c); yield c; }
  });
  const cipher = Buffer.concat(cipherBufs);

  const dec = new DecryptStream(k2);
  await assert.rejects(
    pipe(Readable.from([cipher]), dec, async function* (src) { for await (const _c of src) {} })
  );
});

test('rejects tampered ciphertext', async () => {
  const key = crypto.randomBytes(32);
  const plain = crypto.randomBytes(4096);
  const enc = new EncryptStream(key);
  const cipherBufs = [];
  await pipe(Readable.from([plain]), enc, async function* (src) {
    for await (const c of src) { cipherBufs.push(c); yield c; }
  });
  const cipher = Buffer.concat(cipherBufs);
  // Flip a middle byte.
  const tampered = Buffer.from(cipher);
  const mid = HEADER_LEN + Math.floor((tampered.length - HEADER_LEN - TAG_LEN) / 2);
  tampered[mid] ^= 0x01;

  const dec = new DecryptStream(key);
  await assert.rejects(
    pipe(Readable.from([tampered]), dec, async function* (src) { for await (const _c of src) {} })
  );
});

test('rejects truncated stream (missing tag)', async () => {
  const key = crypto.randomBytes(32);
  const plain = crypto.randomBytes(1024);
  const enc = new EncryptStream(key);
  const cipherBufs = [];
  await pipe(Readable.from([plain]), enc, async function* (src) {
    for await (const c of src) { cipherBufs.push(c); yield c; }
  });
  const cipher = Buffer.concat(cipherBufs);
  const truncated = cipher.slice(0, cipher.length - 5); // chop into the tag

  const dec = new DecryptStream(key);
  await assert.rejects(
    pipe(Readable.from([truncated]), dec, async function* (src) { for await (const _c of src) {} })
  );
});
