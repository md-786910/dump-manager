"use strict";

// Streaming AES-256-GCM for dump files.
//
// File format (little-endian where applicable):
//   magic     : 8 bytes  "DBMENC\x00\x01"   (version 1)
//   nonceLen  : 1 byte   = 12
//   nonce     : 12 bytes random IV
//   ciphertext: N bytes  (chunked; see below)
//   authTag   : 16 bytes GCM tag (over the entire ciphertext)
//
// AES-GCM has a 64 GiB cap per (key, nonce) pair, well above any reasonable dump
// size. The nonce is random per file (random-IV mode is safe at this scale: with
// 96-bit IVs the birthday bound is ~2^32 files before reuse risk; we are
// nowhere near that). A new nonce is generated for every backup.
//
// We intentionally use a single GCM tag for the whole stream rather than
// chunked AEAD. This is simpler and matches how pg_dump output is consumed —
// always read-to-end before being fed to pg_restore. A truncated file fails the
// tag check at the end, which is the correct outcome.

const { Transform } = require("node:stream");
const crypto = require("node:crypto");

const MAGIC = Buffer.from("DBMENC\x00\x01", "binary"); // 8 bytes
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + NONCE_LEN; // magic + nonceLen byte + nonce

function buildHeader(nonce) {
  if (nonce.length !== NONCE_LEN) throw new Error("bad nonce length");
  const buf = Buffer.allocUnsafe(HEADER_LEN);
  MAGIC.copy(buf, 0);
  buf.writeUInt8(NONCE_LEN, MAGIC.length);
  nonce.copy(buf, MAGIC.length + 1);
  return buf;
}

function parseHeader(buf) {
  if (buf.length < HEADER_LEN) throw new Error("header too short");
  if (!buf.slice(0, MAGIC.length).equals(MAGIC))
    throw new Error("bad magic / wrong file type or version");
  const nonceLen = buf.readUInt8(MAGIC.length);
  if (nonceLen !== NONCE_LEN)
    throw new Error("unsupported nonce length: " + nonceLen);
  const nonce = buf.slice(MAGIC.length + 1, MAGIC.length + 1 + NONCE_LEN);
  return { nonce };
}

class EncryptStream extends Transform {
  constructor(key, { nonce } = {}) {
    super();
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw new Error("key must be 32 bytes");
    this._nonce = nonce || crypto.randomBytes(NONCE_LEN);
    if (this._nonce.length !== NONCE_LEN)
      throw new Error("nonce must be 12 bytes");
    this._cipher = crypto.createCipheriv("aes-256-gcm", key, this._nonce);
    this._headerSent = false;
  }

  _transform(chunk, _enc, cb) {
    try {
      if (!this._headerSent) {
        this.push(buildHeader(this._nonce));
        this._headerSent = true;
      }
      this.push(this._cipher.update(chunk));
      cb();
    } catch (err) {
      cb(err);
    }
  }

  _flush(cb) {
    try {
      if (!this._headerSent) {
        this.push(buildHeader(this._nonce));
        this._headerSent = true;
      }
      const last = this._cipher.final();
      if (last.length) this.push(last);
      this.push(this._cipher.getAuthTag()); // appended after ciphertext
      cb();
    } catch (err) {
      cb(err);
    }
  }

  get nonce() {
    return this._nonce;
  }
}

class DecryptStream extends Transform {
  constructor(key) {
    super();
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw new Error("key must be 32 bytes");
    this._key = key;
    this._headerBuf = Buffer.alloc(0);
    this._decipher = null;

    // We must hold back the final TAG_LEN bytes of every incoming chunk: until
    // we hit end-of-stream we cannot know which bytes are the tag versus
    // ciphertext. So we buffer a sliding tail of TAG_LEN bytes.
    this._tail = Buffer.alloc(0);
  }

  _transform(chunk, _enc, cb) {
    try {
      let data = chunk;
      if (!this._decipher) {
        this._headerBuf = Buffer.concat([this._headerBuf, data]);
        if (this._headerBuf.length < HEADER_LEN) return cb();
        const { nonce } = parseHeader(this._headerBuf);
        this._decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          this._key,
          nonce,
        );
        data = this._headerBuf.slice(HEADER_LEN);
        this._headerBuf = null;
      }

      // Combine prior tail with new data, then split off a fresh tail.
      const combined = this._tail.length
        ? Buffer.concat([this._tail, data])
        : data;
      if (combined.length > TAG_LEN) {
        const toDecrypt = combined.slice(0, combined.length - TAG_LEN);
        this._tail = combined.slice(combined.length - TAG_LEN);
        this.push(this._decipher.update(toDecrypt));
      } else {
        this._tail = combined;
      }
      cb();
    } catch (err) {
      cb(err);
    }
  }

  _flush(cb) {
    try {
      if (!this._decipher)
        return cb(new Error("truncated: header never completed"));
      if (this._tail.length !== TAG_LEN) {
        return cb(
          new Error(
            "truncated: missing auth tag (got " +
              this._tail.length +
              " trailing bytes)",
          ),
        );
      }
      this._decipher.setAuthTag(this._tail);
      const last = this._decipher.final(); // throws on auth failure
      if (last.length) this.push(last);
      cb();
    } catch (err) {
      cb(err);
    }
  }
}

module.exports = {
  EncryptStream,
  DecryptStream,
  MAGIC,
  NONCE_LEN,
  TAG_LEN,
  HEADER_LEN,
};
