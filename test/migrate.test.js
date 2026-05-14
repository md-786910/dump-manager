'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transform } = require('../src/main/storage/migrate');

const NOW = '2026-05-13T12:00:00.000Z';

test('migrates one VPS profile to one server + one target', () => {
  const legacy = [{
    id: 'old-1', name: 'prod-api-db', envTag: 'prod', engine: 'postgres',
    kind: 'docker-compose-vps', dbName: 'appdb',
    createdAt: '2026-04-01T00:00:00Z', updatedAt: '2026-04-01T00:00:00Z',
    vps: { host: 'vps.example.com', port: 22, user: 'root', privateKeyPath: '/root/.ssh/id_ed25519',
      composeProjectPath: '/root/intranet', service: 'db' },
  }];

  const { servers, targets, legacyMap } = transform(legacy, NOW);

  assert.equal(servers.length, 1);
  assert.equal(targets.length, 1);
  assert.equal(servers[0].name, 'vps.example.com');
  assert.equal(servers[0].host, 'vps.example.com');
  assert.equal(servers[0].privateKeyPath, '/root/.ssh/id_ed25519');
  assert.equal(servers[0].sudoForDocker, false);

  assert.equal(targets[0].name, 'prod-api-db');
  assert.equal(targets[0].serverId, servers[0].id);
  assert.equal(targets[0].vps.service, 'db');
  assert.equal(targets[0].vps.composeProjectPath, '/root/intranet');
  assert.equal(targets[0].dbName, 'appdb');

  assert.equal(legacyMap['old-1'], targets[0].id);
});

test('two profiles on the same VPS collapse to one server', () => {
  const sharedVps = { host: 'vmi3269642', port: 22, user: 'root', privateKeyPath: '/root/.ssh/id_ed25519' };
  const legacy = [
    { id: 'a', name: 'intranet', envTag: 'prod', engine: 'postgres', kind: 'docker-compose-vps', dbName: 'intranet_main',
      vps: { ...sharedVps, composeProjectPath: '/root/intranet', service: 'db' } },
    { id: 'b', name: 'leanportuptime', envTag: 'staging', engine: 'postgres', kind: 'docker-compose-vps', dbName: 'uptime',
      vps: { ...sharedVps, composeProjectPath: '/root/leanportuptime', service: 'db' } },
  ];

  const { servers, targets } = transform(legacy, NOW);

  assert.equal(servers.length, 1, 'one collapsed server');
  assert.equal(targets.length, 2);
  assert.equal(targets[0].serverId, servers[0].id);
  assert.equal(targets[1].serverId, servers[0].id);
  assert.notEqual(targets[0].id, targets[1].id);
});

test('profiles on different VPSes stay separate', () => {
  const legacy = [
    { id: 'a', name: 't1', envTag: 'prod', engine: 'postgres', kind: 'docker-compose-vps', dbName: 'd1',
      vps: { host: 'host-a', port: 22, user: 'root', privateKeyPath: '/k', composeProjectPath: '/p', service: 'db' } },
    { id: 'b', name: 't2', envTag: 'prod', engine: 'postgres', kind: 'docker-compose-vps', dbName: 'd2',
      vps: { host: 'host-b', port: 22, user: 'root', privateKeyPath: '/k', composeProjectPath: '/p', service: 'db' } },
  ];

  const { servers } = transform(legacy, NOW);

  assert.equal(servers.length, 2);
  assert.notEqual(servers[0].id, servers[1].id);
});

test('different SSH user on the same host produces separate servers', () => {
  const legacy = [
    { id: 'a', name: 't1', envTag: 'prod', engine: 'postgres', kind: 'docker-compose-vps', dbName: 'd1',
      vps: { host: 'h', port: 22, user: 'root', privateKeyPath: '/k', composeProjectPath: '/p', service: 'db' } },
    { id: 'b', name: 't2', envTag: 'prod', engine: 'postgres', kind: 'docker-compose-vps', dbName: 'd2',
      vps: { host: 'h', port: 22, user: 'deploy', privateKeyPath: '/k', composeProjectPath: '/p', service: 'db' } },
  ];
  const { servers } = transform(legacy, NOW);
  assert.equal(servers.length, 2);
});

test('external-uri profile becomes a target with no server, uri blob preserved', () => {
  const legacy = [{
    id: 'u-1', name: 'rds-prod', envTag: 'prod', engine: 'postgres',
    kind: 'external-uri', dbName: 'appdb',
    uri: { enc: 'AAAAB3NzaC...' },
  }];
  const { servers, targets } = transform(legacy, NOW);
  assert.equal(servers.length, 0);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].serverId, undefined);
  assert.deepEqual(targets[0].uri, { enc: 'AAAAB3NzaC...' });
});

test('empty legacy array yields empty output', () => {
  const { servers, targets, legacyMap } = transform([], NOW);
  assert.deepEqual(servers, []);
  assert.deepEqual(targets, []);
  assert.deepEqual(legacyMap, {});
});

test('mixed VPS and URI legacy profiles produce correct mix', () => {
  const legacy = [
    { id: 'a', name: 'vps-target', envTag: 'prod', engine: 'postgres', kind: 'docker-compose-vps', dbName: 'd',
      vps: { host: 'h', port: 22, user: 'root', privateKeyPath: '/k', composeProjectPath: '/p', service: 'db' } },
    { id: 'b', name: 'uri-target', envTag: 'prod', engine: 'postgres', kind: 'external-uri', dbName: 'd',
      uri: { enc: 'XYZ' } },
  ];
  const { servers, targets, legacyMap } = transform(legacy, NOW);
  assert.equal(servers.length, 1);
  assert.equal(targets.length, 2);
  assert.equal(targets[0].kind, 'docker-compose-vps');
  assert.equal(targets[0].serverId, servers[0].id);
  assert.equal(targets[1].kind, 'external-uri');
  assert.equal(targets[1].serverId, undefined);
  assert.equal(Object.keys(legacyMap).length, 2);
});
