'use strict';

// Builds remote shell commands for pg_dump / pg_restore and parses the
// `pg_restore --list` output. All user-provided strings flow through
// `shQuote` so they cannot break out into shell metacharacters.

function shQuote(s) {
  if (s == null) return "''";
  // POSIX single-quote escaping: close, escape, reopen.
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Internal helper — assembles `[sudo ]<composeBin> -p <name>?`
function composePrefix({ composeBin, projectName, sudo }) {
  const bin = composeBin === 'docker-compose' ? 'docker-compose' : 'docker compose';
  const sudoPart = sudo ? 'sudo ' : '';
  const pPart = projectName ? ' -p ' + shQuote(projectName) : '';
  return sudoPart + bin + pPart;
}

// pg_dump's `-Fc` custom format defaults to zlib level 6. That's well-tuned
// for local dumps on a beefy DB server, but on a small VPS it pegs one core
// on zlib and throttles the whole SSH stream to a trickle (the 50-200 KB/s
// "why is my backup so slow" complaint). Level 1 is the right default here:
// still ~3x compression, but roughly 5× less CPU work, often turning a
// 100 KB/s drip into a 5-20 MB/s flow over the same connection.
const DEFAULT_COMPRESSION_LEVEL = 1;

function normalizeCompressionLevel(v) {
  if (v == null || v === '') return DEFAULT_COMPRESSION_LEVEL;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_COMPRESSION_LEVEL;
  return Math.max(0, Math.min(9, Math.trunc(n)));
}

// Backup command run INSIDE the remote container via `compose exec -T`.
//   opts.composeProjectPath  — cd target on the VPS (optional)
//   opts.projectName         — explicit `-p` value (optional, overrides cwd-derived name)
//   opts.composeBin          — 'docker compose' (v2, default) | 'docker-compose' (v1)
//   opts.sudo                — prefix the docker invocation with `sudo`
//   opts.service             — compose service name
//   opts.dbName              — Postgres database
//   opts.pgUser              — optional `-U` override
//   opts.compressionLevel    — pg_dump -Z value, 0..9. Defaults to 1 (fast).
function vpsDumpCommand(opts) {
  const cd = opts.composeProjectPath ? 'cd ' + shQuote(opts.composeProjectPath) + ' && ' : '';
  const pre = composePrefix(opts);
  const userFlag = opts.pgUser ? ' -U ' + shQuote(opts.pgUser) : '';
  const cl = normalizeCompressionLevel(opts.compressionLevel);
  // --verbose makes pg_dump emit per-table progress lines on stderr. We
  // capture them line-by-line and route them into the renderer's log drawer,
  // so a "stuck" backup is diagnosable (e.g. "dumping contents of table X")
  // instead of mysteriously frozen.
  return cd + pre + ' exec -T ' + shQuote(opts.service)
    + ' pg_dump -Fc --verbose -Z ' + cl + userFlag + ' -d ' + shQuote(opts.dbName);
}

function vpsRestoreCommand(opts) {
  const cd = opts.composeProjectPath ? 'cd ' + shQuote(opts.composeProjectPath) + ' && ' : '';
  const pre = composePrefix(opts);
  const userFlag = opts.pgUser ? ' -U ' + shQuote(opts.pgUser) : '';
  const cleanFlag = opts.cleanFirst ? ' --clean --if-exists' : '';
  return cd + pre + ' exec -T ' + shQuote(opts.service)
    + ' pg_restore' + userFlag + cleanFlag + ' -d ' + shQuote(opts.dbName);
}

// Pre-flight: is the DB container actually running?
function composeContainerStatusCommand({ composeProjectPath, projectName, composeBin, sudo, service }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  const pre = composePrefix({ composeBin, projectName, sudo });
  return cd + pre + ' ps --status running --services';
}

// --- Discovery helpers ---

function detectComposeBinCommand() {
  // Try v2 first; if exit != 0, the caller falls back to v1.
  return 'docker compose version --short || true';
}

function composeListCommand({ composeBin, sudo }) {
  return composePrefix({ composeBin, sudo }) + ' ls --format json';
}

function composeConfigServicesCommand({ composeBin, sudo, projectName, composeProjectPath }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  return cd + composePrefix({ composeBin, projectName, sudo }) + ' config --format json';
}

function printenvCommand({ composeBin, sudo, projectName, composeProjectPath, service, varName }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  // `printenv FOO` exits non-zero when unset; the `|| true` keeps stderr clean.
  return cd + composePrefix({ composeBin, projectName, sudo })
    + ' exec -T ' + shQuote(service)
    + ' printenv ' + shQuote(varName) + ' || true';
}

function psqlListDbsCommand({ composeBin, sudo, projectName, composeProjectPath, service, pgUser }) {
  const cd = composeProjectPath ? 'cd ' + shQuote(composeProjectPath) + ' && ' : '';
  return cd + composePrefix({ composeBin, projectName, sudo })
    + ' exec -T ' + shQuote(service)
    + ' psql -U ' + shQuote(pgUser || 'postgres')
    + " -At -F '|' -c "
    + shQuote("SELECT datname FROM pg_database WHERE NOT datistemplate AND datallowconn ORDER BY datname");
}

// --- Parsers ---

// `pg_restore --list` TOC parser (kept from MVP).
function parseListing(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith(';')) continue;
    const m = line.match(/^\s*\d+;\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(.+?)\s+(\S+)\s*$/);
    if (!m) continue;
    items.push({ kind: m[1], schema: m[2], name: m[3], owner: m[4] });
  }
  return items;
}

// `docker compose ls --format json` is an array of:
//   { Name, Status, ConfigFiles }
function parseComposeLs(jsonText) {
  const out = JSON.parse(jsonText);
  if (!Array.isArray(out)) return [];
  return out.map((row) => ({
    name: row.Name || row.name,
    status: row.Status || row.status || '',
    configFiles: (row.ConfigFiles || row.configFiles || '').split(',').map((s) => s.trim()).filter(Boolean),
  }));
}

// `docker compose -p <name> config --format json` returns a compose-file model
// shaped like { services: { svc: { image, ... }, ... } }. We pull out the
// services with their image strings.
function parseComposeConfig(jsonText) {
  const cfg = JSON.parse(jsonText);
  const services = cfg && cfg.services;
  if (!services || typeof services !== 'object') return [];
  return Object.entries(services).map(([name, def]) => ({
    name,
    image: (def && def.image) || null,
  }));
}

function isPostgresImage(image) {
  if (!image) return false;
  // Match `postgres`, `postgres:15`, `postgres:15.4-alpine`, `library/postgres`,
  // `docker.io/postgres`, `registry/repo/postgres:tag` — anything ending in postgres before optional :tag.
  return /(^|[\/])postgres(:|$)/i.test(image);
}

function isMongoImage(image) {
  if (!image) return false;
  return /(^|[\/])mongo(:|$)/i.test(image);
}

// `psql -At -F'|' -c "SELECT ..."` returns one db per line.
function parsePsqlDbList(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

module.exports = {
  DEFAULT_COMPRESSION_LEVEL,
  normalizeCompressionLevel,
  shQuote,
  composePrefix,
  vpsDumpCommand,
  vpsRestoreCommand,
  composeContainerStatusCommand,
  detectComposeBinCommand,
  composeListCommand,
  composeConfigServicesCommand,
  printenvCommand,
  psqlListDbsCommand,
  parseListing,
  parseComposeLs,
  parseComposeConfig,
  isPostgresImage,
  isMongoImage,
  parsePsqlDbList,
};
