'use strict';

// Native MongoDB driver helpers for external-URI connections.
// Used instead of spawning mongosh/mongodump/mongorestore so the app works on
// Windows where those CLI tools may not be installed, and avoids POSIX-only
// $VAR syntax that breaks under cmd.exe.

const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');
const { PassThrough } = require('node:stream');

// ---------------------------------------------------------------------------
// Short-lived client helper
// ---------------------------------------------------------------------------

async function withClient(uri, fn) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try { await client.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// DB Viewer helpers (used by ops/dbViewer.js)
// ---------------------------------------------------------------------------

// List all database names the user can see.
async function listDatabases(uri) {
  return withClient(uri, async (client) => {
    const result = await client.db('admin').command({ listDatabases: 1 });
    return result.databases.map((d) => d.name);
  });
}

// List collection names in a specific database.
async function listCollections(uri, dbName) {
  return withClient(uri, async (client) => {
    const db = client.db(dbName);
    const cols = await db.listCollections().toArray();
    return cols.map((c) => c.name).sort();
  });
}

// Query up to 51 documents from a collection (caller slices to 50 + hasMore).
async function queryCollection(uri, dbName, collection, offset) {
  return withClient(uri, async (client) => {
    const db = client.db(dbName);
    const docs = await db.collection(collection)
      .find({})
      .skip(offset || 0)
      .limit(51)
      .toArray();
    const hasMore = docs.length > 50;
    // Use relaxed EJSON so the UI receives plain JSON-safe objects where
    // ObjectId → hex string, Date → ISO string, Decimal128 → number string.
    // stringify+parse is the simplest cross-version way to do this.
    const serialized = JSON.parse(EJSON.stringify(docs.slice(0, 50), { relaxed: true }));
    return { documents: serialized, hasMore };
  });
}

// ---------------------------------------------------------------------------
// Backup stream  (mimics an ssh2 exec channel — Readable stdout + .stderr)
//
// Archive format: newline-delimited JSON (NDJSON), one record per line:
//   {"type":"header","format":"mongo_json_v1","db":"<name>"}
//   {"type":"collection","name":"<col>"}
//   {"type":"doc","d":{...}}   ← one per document
//   ...more collections / docs...
//   {"type":"end"}
//
// The stream emits 'exit' (code, signal) then 'close' when done, matching
// the ssh2 exec-channel contract that backupVps.js depends on.
// ---------------------------------------------------------------------------

function createBackupStream(uri, dbName) {
  const out = new PassThrough();
  // Attach ssh2-style extras.
  out.stderr  = new PassThrough(); // no meaningful stderr for native path
  out.stdin   = new PassThrough(); // not used for backup
  out.signal  = () => {};          // abort is handled via out.destroy()

  let client = null;

  // Allow the caller to destroy mid-backup (e.g. AbortSignal).
  const origDestroy = out.destroy.bind(out);
  out.destroy = (err) => {
    if (client) { try { client.close(); } catch {} }
    return origDestroy(err);
  };

  (async () => {
    try {
      client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
      await client.connect();

      const db = client.db(dbName);
      const cols = await db.listCollections().toArray();
      const colNames = cols.map((c) => c.name).sort();

      out.push(JSON.stringify({ type: 'header', format: 'mongo_json_v1', db: dbName }) + '\n');

      for (const name of colNames) {
        out.push(JSON.stringify({ type: 'collection', name }) + '\n');
        const cursor = db.collection(name).find({});
        for await (const doc of cursor) {
          // Use strict EJSON so all BSON types (ObjectId, Date, Decimal128,
          // Binary, …) are preserved as {"$oid":"..."} etc. and can be round-
          // tripped back to native BSON types on restore via EJSON.parse().
          out.push(EJSON.stringify({ type: 'doc', d: doc }, { relaxed: false }) + '\n');
        }
      }

      out.push(JSON.stringify({ type: 'end' }) + '\n');
      out.push(null); // EOF — triggers 'end' on the readable side

      await client.close();
      client = null;

      // Emit exit then close — matches ssh2 exec channel ordering.
      out.emit('exit', 0, null);
      out.emit('close');
    } catch (err) {
      if (client) { try { await client.close(); } catch {} client = null; }
      out.stderr.push('mongodump error: ' + err.message + '\n');
      out.stderr.push(null);
      out.push(null);
      out.emit('exit', 1, null);
      out.emit('close');
    }
  })();

  return out;
}

// ---------------------------------------------------------------------------
// Restore channel  (mimics an ssh2 exec channel — Readable stdout + .stdin)
//
// The caller pipes: (decrypted file) → stream.stdin
// When stdin ends, the channel parses the NDJSON and restores each collection.
// It emits 'exit' (0) then 'close' on success, or 'exit' (1) on error.
//
// dropFirst: drop each collection before inserting (--drop equivalent).
// ---------------------------------------------------------------------------

function createRestoreChannel(uri, dbName, { dropFirst = true } = {}) {
  // out (stdout) — restoreVps drains it with stream.resume(); no real output.
  const out = new PassThrough();
  out.stderr = new PassThrough();
  out.signal = () => {};
  out.resume(); // drain immediately — mongorestore produces no useful stdout

  const stdin = new PassThrough();
  out.stdin = stdin;

  let rawData = '';
  stdin.on('data', (chunk) => { rawData += chunk.toString('utf8'); });

  stdin.on('end', () => {
    (async () => {
      let client = null;
      try {
        const lines = rawData.split('\n').filter((l) => l.trim());
        client = new MongoClient(uri, { serverSelectionTimeoutMS: 30000 });
        await client.connect();
        const db = client.db(dbName);

        let currentCol = null;
        let batch = [];

        const flush = async () => {
          if (batch.length && currentCol) {
            await db.collection(currentCol).insertMany(batch, { ordered: false });
            batch = [];
          }
        };

        for (const line of lines) {
          let rec;
          // EJSON.parse restores {"$oid":"..."} → ObjectId, {"$date":...} → Date,
          // etc. so every BSON type written by createBackupStream is preserved.
          try { rec = EJSON.parse(line); } catch { continue; }

          if (rec.type === 'header') {
            // Nothing — connection already open.
          } else if (rec.type === 'collection') {
            await flush();
            currentCol = rec.name;
            if (dropFirst) {
              // Ignore "ns not found" when collection doesn't exist yet.
              await db.collection(currentCol).drop().catch(() => {});
            }
          } else if (rec.type === 'doc' && rec.d) {
            batch.push(rec.d);
            if (batch.length >= 200) await flush();
          }
          // type === 'end': nothing needed
        }
        await flush();

        await client.close();
        client = null;

        out.emit('exit', 0, null);
        out.emit('close');
      } catch (err) {
        if (client) { try { await client.close(); } catch {} }
        const msg = 'mongorestore error: ' + err.message;
        out.stderr.push(msg + '\n');
        out.stderr.push(null);
        out.emit('exit', 1, null);
        out.emit('close');
      }
    })();
  });

  // Allow abort via destroy().
  const origDestroy = out.destroy.bind(out);
  out.destroy = (err) => {
    try { stdin.destroy(); } catch {}
    return origDestroy(err);
  };

  return out;
}

module.exports = {
  // DB viewer
  listDatabases,
  listCollections,
  queryCollection,
  // Backup / restore
  createBackupStream,
  createRestoreChannel,
};
