'use strict';

const pg = require('../db/postgres');
const mg = require('../db/mongo');
const runCommand = require('../exec/runCommand');
const { resolveDockerSudo } = require('../exec/dockerSudo');

async function listTables(ch, target, server) {
  let cmd, env;
  if (target.kind === 'external-uri') {
    cmd = pg.psqlUriListTablesCommand();
    env = { PGURI: target.uri };
  } else {
    const v = target.vps || {};
    const sudo = await resolveDockerSudo(ch, server);
    cmd = pg.psqlListTablesCommand({
      composeBin: target.composeBin || 'docker compose',
      sudo,
      projectName: v.projectName || null,
      composeProjectPath: v.composeProjectPath || null,
      service: v.service,
      pgUser: v.pgUser || null,
      dbName: target.dbName,
    });
  }
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd, env);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'psql exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'PSQL_ERROR' });
  }
  return pg.parsePsqlTableList(stdout);
}

async function queryTable(ch, target, { schema, table, offset }, server) {
  let cmd, env;
  if (target.kind === 'external-uri') {
    cmd = pg.psqlUriQueryTableCommand({ schema, table, offset });
    env = { PGURI: target.uri };
  } else {
    const v = target.vps || {};
    const sudo = await resolveDockerSudo(ch, server);
    cmd = pg.psqlQueryTableCommand({
      composeBin: target.composeBin || 'docker compose',
      sudo,
      projectName: v.projectName || null,
      composeProjectPath: v.composeProjectPath || null,
      service: v.service,
      pgUser: v.pgUser || null,
      dbName: target.dbName,
      schema,
      table,
      offset: offset || 0,
    });
  }
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd, env);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'psql exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'PSQL_ERROR' });
  }
  const { columns, rows } = pg.parsePsqlCsv(stdout);
  const hasMore = rows.length > 50;
  return { columns, rows: rows.slice(0, 50), hasMore };
}

async function listDatabases(ch, target, server) {
  if (target.kind === 'external-uri') throw Object.assign(new Error('DB list not available for URI targets'), { code: 'URI_TARGET' });
  const v = target.vps || {};
  const sudo = await resolveDockerSudo(ch, server);
  const cmd = pg.psqlListDbsCommand({
    composeBin: target.composeBin || 'docker compose',
    sudo,
    projectName: v.projectName || null,
    composeProjectPath: v.composeProjectPath || null,
    service: v.service,
    pgUser: v.pgUser || null,
  });
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'psql exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'PSQL_ERROR' });
  }
  return pg.parsePsqlDbList(stdout);
}

// --- MongoDB View DB ---

function _mongoVpsOpts(target, sudo) {
  const v = target.vps || {};
  return {
    composeBin: target.composeBin || 'docker compose',
    sudo,
    projectName: v.projectName || null,
    composeProjectPath: v.composeProjectPath || null,
    service: v.service,
    dbName: target.dbName,
    mongoUser: v.mongoUser || null,
    mongoPassword: v.mongoPassword || null,
    mongoAuthDb: v.mongoAuthDb || 'admin',
    shell: v.mongoShell || 'mongosh',
  };
}

async function listCollections(ch, target, server) {
  let cmd, env;
  if (target.kind === 'external-uri') {
    cmd = mg.mongoUriListCollectionsCommand({ dbName: target.dbName });
    env = { MONGOURI: target.uri };
  } else {
    const sudo = await resolveDockerSudo(ch, server);
    cmd = mg.mongoListCollectionsCommand(_mongoVpsOpts(target, sudo));
  }
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd, env);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'mongosh exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'MONGO_ERROR' });
  }
  return mg.parseMongoCollections(stdout);
}

async function queryCollection(ch, target, { collection, offset }, server) {
  let cmd, env;
  if (target.kind === 'external-uri') {
    cmd = mg.mongoUriQueryCollectionCommand({ dbName: target.dbName, collection, offset: offset || 0 });
    env = { MONGOURI: target.uri };
  } else {
    const sudo = await resolveDockerSudo(ch, server);
    cmd = mg.mongoQueryCollectionCommand({ ..._mongoVpsOpts(target, sudo), collection, offset: offset || 0 });
  }
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd, env);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'mongosh exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'MONGO_ERROR' });
  }
  return mg.parseMongoDocuments(stdout);
}

module.exports = { listTables, queryTable, listDatabases, listCollections, queryCollection };
