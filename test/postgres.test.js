'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pg = require('../src/main/db/postgres');

test('shQuote escapes single quotes and embeds safely', () => {
  assert.equal(pg.shQuote(''), "''");
  assert.equal(pg.shQuote('simple'), "'simple'");
  assert.equal(pg.shQuote("a'b"), "'a'\\''b'");
  assert.equal(pg.shQuote('a b c'), "'a b c'");
});

test('vpsDumpCommand uses docker compose v2 + default compression (Z 1) + --verbose', () => {
  const cmd = pg.vpsDumpCommand({
    composeProjectPath: '/srv/app', service: 'db', dbName: 'appdb',
  });
  assert.match(cmd, /^cd '\/srv\/app' && docker compose exec -T 'db' pg_dump -Fc --verbose -Z 1 -d 'appdb'$/);
});

test('vpsDumpCommand honors an explicit compression level', () => {
  const cmd = pg.vpsDumpCommand({ service: 'db', dbName: 'appdb', compressionLevel: 6 });
  assert.match(cmd, /pg_dump -Fc --verbose -Z 6 /);
});

test('vpsDumpCommand clamps compression level to 0..9 and falls back on garbage', () => {
  assert.match(pg.vpsDumpCommand({ service: 'db', dbName: 'd', compressionLevel: -3 }), /-Z 0 /);
  assert.match(pg.vpsDumpCommand({ service: 'db', dbName: 'd', compressionLevel: 99 }), /-Z 9 /);
  assert.match(pg.vpsDumpCommand({ service: 'db', dbName: 'd', compressionLevel: 'nope' }), /-Z 1 /);
});

test('vpsDumpCommand falls back to docker-compose when composeBin says so', () => {
  const cmd = pg.vpsDumpCommand({
    composeProjectPath: '/srv/app', service: 'db', dbName: 'appdb',
    composeBin: 'docker-compose',
  });
  assert.match(cmd, /docker-compose exec/);
  assert.doesNotMatch(cmd, /docker compose/);
});

test('vpsDumpCommand prefixes sudo when requested', () => {
  const cmd = pg.vpsDumpCommand({ service: 'db', dbName: 'appdb', sudo: true });
  assert.match(cmd, /^sudo docker compose exec/);
});

test('vpsDumpCommand passes explicit projectName via -p', () => {
  const cmd = pg.vpsDumpCommand({ service: 'db', dbName: 'appdb', projectName: 'intranet' });
  assert.match(cmd, /docker compose -p 'intranet' exec/);
});

test('vpsDumpCommand includes -U pgUser when supplied', () => {
  const cmd = pg.vpsDumpCommand({ service: 'db', dbName: 'appdb', pgUser: 'app_user' });
  assert.match(cmd, / -U 'app_user' /);
});

test('vpsDumpCommand omits cd when no composeProjectPath', () => {
  const cmd = pg.vpsDumpCommand({ service: 'db', dbName: 'appdb' });
  assert.equal(cmd.startsWith('cd '), false);
});

test('vpsDumpCommand resists shell injection in dbName', () => {
  const cmd = pg.vpsDumpCommand({ service: 'db', dbName: "x'; rm -rf / #" });
  // The whole malicious string is wrapped in a single-quoted POSIX-safe form.
  assert.match(cmd, /-d 'x'\\''; rm -rf \/ #'/);
  // And no unquoted semicolon leaks at the top level.
  const outsideQuotes = cmd.replace(/'[^']*(?:'\\''[^']*)*'/g, '');
  assert.equal(outsideQuotes.includes(';'), false, 'no top-level shell metacharacters: ' + outsideQuotes);
});

test('composeContainerStatusCommand respects bin + sudo + projectName', () => {
  const cmd = pg.composeContainerStatusCommand({
    composeProjectPath: '/srv/app', service: 'db',
    composeBin: 'docker-compose', sudo: true, projectName: 'intranet',
  });
  assert.match(cmd, /^cd '\/srv\/app' && sudo docker-compose -p 'intranet' ps --status running --services$/);
});

test('parseComposeLs handles the v2 output shape', () => {
  const json = JSON.stringify([
    { Name: 'intranet', Status: 'running(3)', ConfigFiles: '/root/intranet/docker-compose.yml' },
    { Name: 'leanportuptime', Status: 'running(2)', ConfigFiles: '/root/leanportuptime/compose.yml' },
  ]);
  const out = pg.parseComposeLs(json);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'intranet');
  assert.deepEqual(out[0].configFiles, ['/root/intranet/docker-compose.yml']);
});

test('parseComposeLs handles empty array', () => {
  assert.deepEqual(pg.parseComposeLs('[]'), []);
});

test('parseComposeConfig extracts services and images', () => {
  const json = JSON.stringify({
    services: {
      db: { image: 'postgres:15.4' },
      app: { image: 'myapp:latest' },
      cache: { image: 'redis:7' },
    },
  });
  const out = pg.parseComposeConfig(json);
  const byName = Object.fromEntries(out.map((s) => [s.name, s.image]));
  assert.equal(byName.db, 'postgres:15.4');
  assert.equal(byName.app, 'myapp:latest');
});

test('isPostgresImage matches common shapes', () => {
  assert.equal(pg.isPostgresImage('postgres'), true);
  assert.equal(pg.isPostgresImage('postgres:15'), true);
  assert.equal(pg.isPostgresImage('postgres:15.4-alpine'), true);
  assert.equal(pg.isPostgresImage('library/postgres'), true);
  assert.equal(pg.isPostgresImage('docker.io/library/postgres:16'), true);
  assert.equal(pg.isPostgresImage('mysql:8'), false);
  assert.equal(pg.isPostgresImage('postgresql-client:13'), false); // similar but not the server image
  assert.equal(pg.isPostgresImage(''), false);
  assert.equal(pg.isPostgresImage(null), false);
});

test('parsePsqlDbList strips blanks and whitespace', () => {
  const out = pg.parsePsqlDbList('intranet_main\nintranet_audit\n\n  uptime  \n');
  assert.deepEqual(out, ['intranet_main', 'intranet_audit', 'uptime']);
});

test('uriDumpCommand uses $PGURI env (no URI in argv) with default compression', () => {
  const cmd = pg.uriDumpCommand({});
  assert.match(cmd, /^pg_dump -Fc --verbose -Z 1 -d "\$PGURI"$/);
});

test('uriDumpCommand honors custom compression level', () => {
  const cmd = pg.uriDumpCommand({ compressionLevel: 6 });
  assert.match(cmd, /-Z 6 /);
});

test('uriRestoreCommand without cleanFirst', () => {
  assert.equal(pg.uriRestoreCommand({}), 'pg_restore -d "$PGURI"');
});

test('uriRestoreCommand with cleanFirst adds --clean --if-exists', () => {
  assert.equal(pg.uriRestoreCommand({ cleanFirst: true }), 'pg_restore --clean --if-exists -d "$PGURI"');
});

test('parseListing parses pg_restore --list output', () => {
  const text = [
    '; Archive created by pg_dump',
    ';',
    '215; 1259 16456 TABLE public users postgres',
    '216; 1259 16462 SEQUENCE public users_id_seq postgres',
  ].join('\n');
  const items = pg.parseListing(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'TABLE');
  assert.equal(items[0].name, 'users');
  assert.equal(items[1].kind, 'SEQUENCE');
});

// --- psql restore command builders (plain SQL restore) ---

test('vpsPsqlRestoreCommand uses psql not pg_restore', () => {
  const cmd = pg.vpsPsqlRestoreCommand({
    service: 'db', dbName: 'appdb',
  });
  assert.match(cmd, /psql -d 'appdb'$/);
  assert.doesNotMatch(cmd, /pg_restore/);
});

test('vpsPsqlRestoreCommand includes -U pgUser when supplied', () => {
  const cmd = pg.vpsPsqlRestoreCommand({ service: 'db', dbName: 'appdb', pgUser: 'app_user' });
  assert.match(cmd, / -U 'app_user' /);
});

test('vpsPsqlRestoreCommand includes cd and compose prefix when composeProjectPath given', () => {
  const cmd = pg.vpsPsqlRestoreCommand({
    composeProjectPath: '/srv/app', service: 'db', dbName: 'appdb',
  });
  assert.match(cmd, /^cd '\/srv\/app' && docker compose exec -T 'db' psql -d 'appdb'$/);
});

test('vpsPsqlRestoreCommand does not include --clean (ignored for plain SQL)', () => {
  const cmd = pg.vpsPsqlRestoreCommand({ service: 'db', dbName: 'appdb', cleanFirst: true });
  assert.doesNotMatch(cmd, /--clean/);
  assert.doesNotMatch(cmd, /--if-exists/);
});

test('vpsPsqlRestoreCommand respects sudo flag', () => {
  const cmd = pg.vpsPsqlRestoreCommand({ service: 'db', dbName: 'appdb', sudo: true });
  assert.match(cmd, /^sudo docker compose exec/);
});

test('vpsPsqlRestoreCommand uses docker-compose bin when specified', () => {
  const cmd = pg.vpsPsqlRestoreCommand({ service: 'db', dbName: 'appdb', composeBin: 'docker-compose' });
  assert.match(cmd, /docker-compose exec/);
  assert.doesNotMatch(cmd, /docker compose exec/);
});

test('installedPsqlRestoreCommand uses psql not pg_restore', () => {
  const cmd = pg.installedPsqlRestoreCommand({
    host: 'localhost', port: 5432, dbUser: 'admin', dbName: 'appdb',
  });
  assert.match(cmd, /^psql -h 'localhost' -p 5432 -U 'admin' -d 'appdb'$/);
  assert.doesNotMatch(cmd, /pg_restore/);
  assert.doesNotMatch(cmd, /--clean/);
});

test('installedPsqlRestoreCommand uses dbNameOverride when provided', () => {
  const cmd = pg.installedPsqlRestoreCommand({
    host: 'localhost', dbName: 'appdb', dbNameOverride: 'restored_db',
  });
  assert.match(cmd, /-d 'restored_db'$/);
});

test('installedPsqlRestoreCommand prefixes PGPASSWORD when embedPassword is true', () => {
  const cmd = pg.installedPsqlRestoreCommand({
    host: 'localhost', dbName: 'appdb', embedPassword: true, dbPassword: 's3cr3t',
  });
  assert.match(cmd, /^PGPASSWORD='s3cr3t' psql/);
});

test('installedPsqlRestoreCommand omits PGPASSWORD when embedPassword is false', () => {
  const cmd = pg.installedPsqlRestoreCommand({
    host: 'localhost', dbName: 'appdb', embedPassword: false, dbPassword: 's3cr3t',
  });
  assert.doesNotMatch(cmd, /PGPASSWORD/);
  assert.match(cmd, /^psql/);
});

test('uriPsqlRestoreCommand uses $PGURI env var', () => {
  assert.equal(pg.uriPsqlRestoreCommand(), 'psql "$PGURI"');
});

test('pgRestoreToSqlCommand produces plain format stdout output', () => {
  assert.equal(pg.pgRestoreToSqlCommand(), 'pg_restore --format=plain -f -');
});
