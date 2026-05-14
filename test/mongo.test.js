'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const mg = require('../src/main/db/mongo');

// --- mongoDumpCommand ---

test('mongoDumpCommand: basic without auth', () => {
  const cmd = mg.mongoDumpCommand({
    composeBin: 'docker compose', sudo: false, projectName: 'myapp',
    composeProjectPath: '/srv/myapp', service: 'mongo', dbName: 'appdb',
    mongoUser: null, mongoPassword: null, mongoAuthDb: 'admin',
  });
  assert.ok(cmd.includes('mongodump'), 'should call mongodump');
  assert.ok(cmd.includes("--db 'appdb'"), 'should include db name');
  assert.ok(cmd.includes('--archive'), 'should stream via --archive');
  assert.ok(!cmd.includes('--username'), 'should omit auth when no user');
  assert.ok(!cmd.includes('MONGO_PWD'), 'should omit MONGO_PWD when no password');
});

test('mongoDumpCommand: with auth sets env var and --username flag', () => {
  const cmd = mg.mongoDumpCommand({
    composeBin: 'docker compose', sudo: false, projectName: null,
    composeProjectPath: null, service: 'db', dbName: 'prod',
    mongoUser: 'root', mongoPassword: 's3cr3t', mongoAuthDb: 'admin',
  });
  assert.ok(cmd.includes("-e MONGO_PWD='s3cr3t'"), 'should pass MONGO_PWD env');
  assert.ok(cmd.includes('--username \'root\''), 'should include username');
  assert.ok(cmd.includes('--password "$MONGO_PWD"'), 'should use env var for password');
  assert.ok(cmd.includes("--authenticationDatabase 'admin'"), 'should include authDb');
});

test('mongoDumpCommand: password with single quotes is safely escaped', () => {
  const cmd = mg.mongoDumpCommand({
    composeBin: 'docker compose', sudo: false, projectName: null,
    composeProjectPath: null, service: 'db', dbName: 'x',
    mongoUser: 'u', mongoPassword: "it's tricky", mongoAuthDb: 'admin',
  });
  assert.ok(!cmd.includes("it's tricky"), 'raw single-quote password must not appear unescaped');
  assert.ok(cmd.includes('MONGO_PWD'), 'password still passed via env');
});

// --- mongoRestoreCommand ---

test('mongoRestoreCommand: includes --drop and --archive', () => {
  const cmd = mg.mongoRestoreCommand({
    composeBin: 'docker compose', sudo: false, projectName: null,
    composeProjectPath: null, service: 'mongo', dbName: 'mydb',
    dbNameOverride: null, mongoUser: null, mongoPassword: null, mongoAuthDb: 'admin',
  });
  assert.ok(cmd.includes('mongorestore'), 'should call mongorestore');
  assert.ok(cmd.includes('--archive'), 'should stream via --archive');
  assert.ok(cmd.includes('--drop'), 'should drop before restore');
});

test('mongoRestoreCommand: dbNameOverride replaces dbName', () => {
  const cmd = mg.mongoRestoreCommand({
    composeBin: 'docker compose', sudo: false, projectName: null,
    composeProjectPath: null, service: 'mongo', dbName: 'original',
    dbNameOverride: 'newdb', mongoUser: null, mongoPassword: null, mongoAuthDb: 'admin',
  });
  assert.ok(cmd.includes("--db 'newdb'"), 'should use override db name');
  assert.ok(!cmd.includes("--db 'original'"), 'should not use original db name');
});

// --- URI commands ---

test('mongoUriDumpCommand uses $MONGOURI', () => {
  const cmd = mg.mongoUriDumpCommand();
  assert.ok(cmd.includes('$MONGOURI'), 'should reference MONGOURI env var');
  assert.ok(cmd.includes('mongodump'), 'should call mongodump');
});

test('mongoUriRestoreCommand uses $MONGOURI', () => {
  const cmd = mg.mongoUriRestoreCommand();
  assert.ok(cmd.includes('$MONGOURI'), 'should reference MONGOURI env var');
  assert.ok(cmd.includes('mongorestore'), 'should call mongorestore');
});

// --- parseMongoDbs ---

test('parseMongoDbs: parses JSON array', () => {
  const dbs = mg.parseMongoDbs('["admin","local","mydb"]');
  assert.deepEqual(dbs, ['admin', 'local', 'mydb']);
});

test('parseMongoDbs: strips leading output before JSON array', () => {
  const dbs = mg.parseMongoDbs('Current Mongosh Log ID: abc\n["admin","local"]');
  assert.deepEqual(dbs, ['admin', 'local']);
});

test('parseMongoDbs: returns empty array for empty output', () => {
  assert.deepEqual(mg.parseMongoDbs(''), []);
  assert.deepEqual(mg.parseMongoDbs('  '), []);
});

// --- parseMongoCollections ---

test('parseMongoCollections: parses JSON array of names', () => {
  const cols = mg.parseMongoCollections('["users","orders","products"]');
  assert.deepEqual(cols, ['users', 'orders', 'products']);
});

// --- parseMongoDocuments ---

test('parseMongoDocuments: parses documents and detects hasMore', () => {
  const docs51 = Array.from({ length: 51 }, (_, i) => ({ _id: i, v: 'x' }));
  const { documents, hasMore } = mg.parseMongoDocuments(JSON.stringify(docs51));
  assert.equal(documents.length, 50, 'should return exactly 50 docs');
  assert.equal(hasMore, true, 'should report hasMore when 51 returned');
});

test('parseMongoDocuments: no hasMore when fewer than 51 docs', () => {
  const docs5 = [{ _id: 1 }, { _id: 2 }];
  const { documents, hasMore } = mg.parseMongoDocuments(JSON.stringify(docs5));
  assert.equal(documents.length, 2);
  assert.equal(hasMore, false);
});

test('parseMongoDocuments: returns empty on blank output', () => {
  const { documents, hasMore } = mg.parseMongoDocuments('');
  assert.equal(documents.length, 0);
  assert.equal(hasMore, false);
});
