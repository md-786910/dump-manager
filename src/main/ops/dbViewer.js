'use strict';

const pg = require('../db/postgres');
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

module.exports = { listTables, queryTable, listDatabases };
