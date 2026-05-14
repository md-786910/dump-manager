'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const pg = require('../src/main/db/postgres');

// pgIdent
test('pgIdent wraps in double quotes', () => {
  assert.equal(pg.pgIdent('users'), '"users"');
});
test('pgIdent escapes embedded double quotes', () => {
  assert.equal(pg.pgIdent('weird"name'), '"weird""name"');
});

// parsePsqlTableList
test('parsePsqlTableList parses pipe-delimited rows', () => {
  const text = 'public|users|42|16 kB\npublic|orders|1000|128 kB\n';
  const result = pg.parsePsqlTableList(text);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { schema: 'public', table: 'users', approxRows: 42, totalSize: '16 kB' });
  assert.deepEqual(result[1], { schema: 'public', table: 'orders', approxRows: 1000, totalSize: '128 kB' });
});
test('parsePsqlTableList ignores blank lines', () => {
  const result = pg.parsePsqlTableList('\n\n');
  assert.deepEqual(result, []);
});

// parsePsqlCsv
test('parsePsqlCsv parses header + rows', () => {
  const text = 'id,name,email\n1,Alice,alice@example.com\n2,Bob,bob@example.com\n';
  const { columns, rows } = pg.parsePsqlCsv(text);
  assert.deepEqual(columns, ['id', 'name', 'email']);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['1', 'Alice', 'alice@example.com']);
});
test('parsePsqlCsv handles quoted fields with commas', () => {
  const text = 'a,b\n"hello, world","it""s ok"\n';
  const { columns, rows } = pg.parsePsqlCsv(text);
  assert.deepEqual(columns, ['a', 'b']);
  assert.deepEqual(rows[0], ['hello, world', 'it"s ok']);
});
test('parsePsqlCsv returns empty for blank input', () => {
  const { columns, rows } = pg.parsePsqlCsv('');
  assert.deepEqual(columns, []);
  assert.deepEqual(rows, []);
});

// psqlListTablesCommand / psqlQueryTableCommand smoke
test('psqlListTablesCommand includes LIST_TABLES_SQL and service', () => {
  const cmd = pg.psqlListTablesCommand({
    composeBin: 'docker compose', sudo: false,
    projectName: 'myapp', composeProjectPath: null,
    service: 'db', pgUser: 'postgres', dbName: 'mydb',
  });
  assert.ok(cmd.includes('pg_class'), 'should include SQL');
  assert.ok(cmd.includes("'db'"), 'should include service');
  assert.ok(cmd.includes("'mydb'"), 'should include dbName');
});
test('psqlQueryTableCommand wraps schema+table with pgIdent', () => {
  const cmd = pg.psqlQueryTableCommand({
    composeBin: 'docker compose', sudo: false,
    projectName: null, composeProjectPath: null,
    service: 'db', pgUser: null, dbName: 'mydb',
    schema: 'public', table: 'users', offset: 50,
  });
  assert.ok(cmd.includes('"public"."users"'), 'should include quoted idents');
  assert.ok(cmd.includes('OFFSET 50'), 'should include offset');
});
test('psqlUriListTablesCommand uses PGURI env var', () => {
  const cmd = pg.psqlUriListTablesCommand();
  assert.ok(cmd.includes('"$PGURI"'), 'should reference $PGURI');
});
test('psqlUriQueryTableCommand includes schema.table and offset', () => {
  const cmd = pg.psqlUriQueryTableCommand({ schema: 'app', table: 'events', offset: 100 });
  assert.ok(cmd.includes('"app"."events"'));
  assert.ok(cmd.includes('OFFSET 100'));
});
