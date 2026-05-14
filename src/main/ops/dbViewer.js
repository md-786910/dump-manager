'use strict';

const pg = require('../db/postgres');
const mg = require('../db/mongo');
const runCommand = require('../exec/runCommand');

async function listTables(ch, target) {
  let cmd;
  if (target.kind === 'external-uri') {
    cmd = pg.psqlUriListTablesCommand();
  } else {
    const v = target.vps || {};
    cmd = pg.psqlListTablesCommand({
      composeBin: target.composeBin || 'docker compose',
      sudo: target.sudoForDocker || false,
      projectName: v.projectName || null,
      composeProjectPath: v.composeProjectPath || null,
      service: v.service,
      pgUser: v.pgUser || null,
      dbName: target.dbName,
    });
  }
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'psql exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'PSQL_ERROR' });
  }
  return pg.parsePsqlTableList(stdout);
}

async function queryTable(ch, target, { schema, table, offset }) {
  let cmd;
  if (target.kind === 'external-uri') {
    cmd = pg.psqlUriQueryTableCommand({ schema, table, offset });
  } else {
    const v = target.vps || {};
    cmd = pg.psqlQueryTableCommand({
      composeBin: target.composeBin || 'docker compose',
      sudo: target.sudoForDocker || false,
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
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'psql exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'PSQL_ERROR' });
  }
  const { columns, rows } = pg.parsePsqlCsv(stdout);
  const hasMore = rows.length > 50;
  return { columns, rows: rows.slice(0, 50), hasMore };
}

async function listDatabases(ch, target) {
  if (target.kind === 'external-uri') throw Object.assign(new Error('DB list not available for URI targets'), { code: 'URI_TARGET' });
  const v = target.vps || {};
  const cmd = pg.psqlListDbsCommand({
    composeBin: target.composeBin || 'docker compose',
    sudo: target.sudoForDocker || false,
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

function _mongoVpsOpts(target) {
  const v = target.vps || {};
  return {
    composeBin: target.composeBin || 'docker compose',
    sudo: target.sudoForDocker || false,
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

async function listCollections(ch, target) {
  let cmd;
  if (target.kind === 'external-uri') {
    cmd = mg.mongoUriListCollectionsCommand({ dbName: target.dbName });
  } else {
    cmd = mg.mongoListCollectionsCommand(_mongoVpsOpts(target));
  }
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'mongosh exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'MONGO_ERROR' });
  }
  return mg.parseMongoCollections(stdout);
}

async function queryCollection(ch, target, { collection, offset }) {
  let cmd;
  if (target.kind === 'external-uri') {
    cmd = mg.mongoUriQueryCollectionCommand({ collection, offset: offset || 0 });
  } else {
    cmd = mg.mongoQueryCollectionCommand({ ..._mongoVpsOpts(target), collection, offset: offset || 0 });
  }
  const { stdout, stderr, exitCode } = await runCommand(ch, cmd);
  if (exitCode !== 0) {
    const msg = (stderr || stdout || 'mongosh exited ' + exitCode).trim();
    throw Object.assign(new Error(msg), { code: 'MONGO_ERROR' });
  }
  return mg.parseMongoDocuments(stdout);
}

module.exports = { listTables, queryTable, listDatabases, listCollections, queryCollection };
