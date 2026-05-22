'use strict';

// Builds shell commands for mongodump / mongorestore / mongosh and parsers
// for their output. All user strings flow through shQuote. Passwords are
// passed via -e MONGO_PWD env var on docker compose exec to avoid appearing
// in ps listings inside the container.

const { shQuote, composePrefix } = require('./postgres');

// --- Command helpers ---

// Credential flags for mongodump / mongorestore CLI.
// Emits nothing when no user is configured (unauthenticated container).
function _authFlags(mongoUser, mongoAuthDb) {
  if (!mongoUser) return '';
  return ' --username ' + shQuote(mongoUser)
    + ' --password "$MONGO_PWD"'
    + ' --authenticationDatabase ' + shQuote(mongoAuthDb || 'admin');
}

// --- Backup ---

function mongoDumpCommand({ composeBin, sudo, projectName, composeProjectPath, service, dbName, mongoUser, mongoPassword, mongoAuthDb }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  const pre = composePrefix({ composeBin, sudo, projectName });
  const eFlag = mongoPassword ? ' -e MONGO_PWD=' + shQuote(mongoPassword) : '';
  return cd + pre + ' exec -T' + eFlag + ' ' + shQuote(service)
    + ' mongodump --db ' + shQuote(dbName)
    + _authFlags(mongoUser, mongoAuthDb)
    + ' --archive';
}

function mongoUriDumpCommand() {
  return 'mongodump --uri "$MONGOURI" --archive';
}

// --- Restore ---

function mongoRestoreCommand({ composeBin, sudo, projectName, composeProjectPath, service, dbName, dbNameOverride, mongoUser, mongoPassword, mongoAuthDb }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  const pre = composePrefix({ composeBin, sudo, projectName });
  const eFlag = mongoPassword ? ' -e MONGO_PWD=' + shQuote(mongoPassword) : '';
  const targetDb = dbNameOverride || dbName;
  return cd + pre + ' exec -T' + eFlag + ' ' + shQuote(service)
    + ' mongorestore --db ' + shQuote(targetDb)
    + _authFlags(mongoUser, mongoAuthDb)
    + ' --drop --archive';
}

function mongoUriRestoreCommand() {
  return 'mongorestore --uri "$MONGOURI" --drop --archive';
}

// --- Installed (direct, non-Docker) backup/restore ---

function mongoInstalledDumpCommand({ host, port, dbName, mongoUser, mongoPassword, mongoAuthDb, embedPassword }) {
  const h = '--host ' + shQuote(host || 'localhost');
  const p = port ? ' --port ' + Number(port) : '';
  const authArgs = mongoUser
    ? ' --username ' + shQuote(mongoUser) + ' --password "$MONGO_PWD"'
      + ' --authenticationDatabase ' + shQuote(mongoAuthDb || 'admin')
    : '';
  const passPrefix = embedPassword && mongoPassword ? 'MONGO_PWD=' + shQuote(mongoPassword) + ' ' : '';
  return passPrefix + 'mongodump ' + h + p + ' --db ' + shQuote(dbName) + authArgs + ' --archive';
}

function mongoInstalledRestoreCommand({ host, port, dbName, dbNameOverride, mongoUser, mongoPassword, mongoAuthDb, embedPassword }) {
  const h = '--host ' + shQuote(host || 'localhost');
  const p = port ? ' --port ' + Number(port) : '';
  const targetDb = dbNameOverride || dbName;
  const authArgs = mongoUser
    ? ' --username ' + shQuote(mongoUser) + ' --password "$MONGO_PWD"'
      + ' --authenticationDatabase ' + shQuote(mongoAuthDb || 'admin')
    : '';
  const passPrefix = embedPassword && mongoPassword ? 'MONGO_PWD=' + shQuote(mongoPassword) + ' ' : '';
  return passPrefix + 'mongorestore ' + h + p + ' --db ' + shQuote(targetDb) + authArgs + ' --drop --archive';
}

// --- Discovery: list databases ---

// Probes which mongo shell binary is available. Try mongosh first (v1.0+),
// fall back to mongo (legacy). Returns the binary name to use.
function mongoShellProbeCommand({ composeBin, sudo, projectName, composeProjectPath, service }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  const pre = composePrefix({ composeBin, sudo, projectName });
  return cd + pre + ' exec -T ' + shQuote(service)
    + " sh -c 'mongosh --version > /dev/null 2>&1 && echo mongosh || echo mongo'";
}

function mongoUriListDbsCommand({ shell }) {
  const sh = shell || 'mongosh';
  const evalExpr = "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(function(d){return d.name}))";
  return sh + ' "$MONGOURI" --quiet --eval ' + shQuote(evalExpr);
}

function mongoInstalledListDbsCommand({ host, port, mongoUser, mongoPassword, mongoAuthDb, embedPassword }) {
  const h = '--host ' + shQuote(host || 'localhost');
  const p = port ? ' --port ' + Number(port) : '';
  const authArgs = mongoUser
    ? ' --username ' + shQuote(mongoUser) + ' --password "$MONGO_PWD" --authenticationDatabase ' + shQuote(mongoAuthDb || 'admin')
    : '';
  const passPrefix = embedPassword && mongoPassword ? 'MONGO_PWD=' + shQuote(mongoPassword) + ' ' : '';
  const evalExpr = "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(function(d){return d.name}))";
  return passPrefix + 'mongosh ' + h + p + authArgs + ' --quiet --eval ' + shQuote(evalExpr);
}

function mongoListDbsCommand({ composeBin, sudo, projectName, composeProjectPath, service, mongoUser, mongoPassword, mongoAuthDb, shell }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  const pre = composePrefix({ composeBin, sudo, projectName });
  const sh = shell || 'mongosh';
  const eFlag = mongoPassword ? ' -e MONGO_PWD=' + shQuote(mongoPassword) : '';
  const authArgs = mongoUser
    ? ' --username ' + shQuote(mongoUser) + ' --password "$MONGO_PWD" --authenticationDatabase ' + shQuote(mongoAuthDb || 'admin')
    : '';
  const evalExpr = "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(function(d){return d.name}))";
  return cd + pre + ' exec -T' + eFlag + ' ' + shQuote(service)
    + ' ' + sh + authArgs + ' --quiet --eval ' + shQuote(evalExpr);
}

// --- View DB: list collections ---

function mongoListCollectionsCommand({ composeBin, sudo, projectName, composeProjectPath, service, dbName, mongoUser, mongoPassword, mongoAuthDb, shell }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  const pre = composePrefix({ composeBin, sudo, projectName });
  const sh = shell || 'mongosh';
  const eFlag = mongoPassword ? ' -e MONGO_PWD=' + shQuote(mongoPassword) : '';
  const authArgs = mongoUser
    ? ' --username ' + shQuote(mongoUser) + ' --password "$MONGO_PWD" --authenticationDatabase ' + shQuote(mongoAuthDb || 'admin')
    : '';
  const evalExpr = "JSON.stringify(db.getCollectionNames())";
  return cd + pre + ' exec -T' + eFlag + ' ' + shQuote(service)
    + ' ' + sh + authArgs + ' --db ' + shQuote(dbName) + ' --quiet --eval ' + shQuote(evalExpr);
}

// --- View DB: query documents ---

function mongoQueryCollectionCommand({ composeBin, sudo, projectName, composeProjectPath, service, dbName, collection, offset, mongoUser, mongoPassword, mongoAuthDb, shell }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  const pre = composePrefix({ composeBin, sudo, projectName });
  const sh = shell || 'mongosh';
  const eFlag = mongoPassword ? ' -e MONGO_PWD=' + shQuote(mongoPassword) : '';
  const authArgs = mongoUser
    ? ' --username ' + shQuote(mongoUser) + ' --password "$MONGO_PWD" --authenticationDatabase ' + shQuote(mongoAuthDb || 'admin')
    : '';
  const n = (offset | 0);
  // EJSON.stringify handles ObjectId, Date, etc. gracefully.
  const evalExpr = "JSON.stringify(db[" + shQuote(collection) + "].find().sort({_id:1}).skip(" + n + ").limit(51).toArray())";
  return cd + pre + ' exec -T' + eFlag + ' ' + shQuote(service)
    + ' ' + sh + authArgs + ' --db ' + shQuote(dbName) + ' --quiet --eval ' + shQuote(evalExpr);
}

// External-URI variants for View DB.
function mongoUriListCollectionsCommand({ dbName, shell }) {
  const sh = shell || 'mongosh';
  return sh + ' "$MONGOURI" --db ' + shQuote(dbName) + ' --quiet --eval ' + shQuote("JSON.stringify(db.getCollectionNames())");
}

function mongoUriQueryCollectionCommand({ dbName, collection, offset, shell }) {
  const sh = shell || 'mongosh';
  const n = (offset | 0);
  const evalExpr = "JSON.stringify(db[" + shQuote(collection) + "].find().sort({_id:1}).skip(" + n + ").limit(51).toArray())";
  return sh + ' "$MONGOURI" --db ' + shQuote(dbName) + ' --quiet --eval ' + shQuote(evalExpr);
}

// --- Parsers ---

// Parse JSON array of database/collection names.
function parseMongoNameList(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // mongosh sometimes prepends a blank line or connection message; find the JSON array.
  const start = trimmed.indexOf('[');
  if (start === -1) return [];
  return JSON.parse(trimmed.slice(start));
}

function parseMongoDbs(text) { return parseMongoNameList(text); }
function parseMongoCollections(text) { return parseMongoNameList(text); }

// Parse JSON array of documents. Returns { documents, hasMore }.
function parseMongoDocuments(text) {
  const trimmed = text.trim();
  if (!trimmed) return { documents: [], hasMore: false };
  const start = trimmed.indexOf('[');
  if (start === -1) return { documents: [], hasMore: false };
  const all = JSON.parse(trimmed.slice(start));
  const hasMore = all.length > 50;
  return { documents: all.slice(0, 50), hasMore };
}

module.exports = {
  mongoUriListDbsCommand,
  mongoInstalledListDbsCommand,
  mongoInstalledDumpCommand,
  mongoInstalledRestoreCommand,
  mongoDumpCommand,
  mongoUriDumpCommand,
  mongoRestoreCommand,
  mongoUriRestoreCommand,
  mongoShellProbeCommand,
  mongoListDbsCommand,
  mongoListCollectionsCommand,
  mongoQueryCollectionCommand,
  mongoUriListCollectionsCommand,
  mongoUriQueryCollectionCommand,
  parseMongoDbs,
  parseMongoCollections,
  parseMongoDocuments,
};
