#!/usr/bin/env node
'use strict';

// Build installers for every supported OS and publish the artifacts + update
// manifests to a Cloudflare R2 bucket.
//
// Local dev: `npm run release` — reads .env, builds for the host OS, uploads.
// CI (GitHub Actions): the workflow injects R2_* + CF_PAGES_DEPLOY_HOOK as
//   secrets. Each runner builds for its own OS (linux / win / mac) and uploads
//   only its artifacts. No coordination needed because filenames are disjoint
//   across platforms; only the platform-specific latest-*.yml manifests are
//   overwritten and each runner owns exactly one.
//
// CLI flags (positional):
//   npm run release                  — host OS only (linux | win | mac)
//   npm run release -- linux         — explicit single OS
//   npm run release -- linux win mac — all three (requires Wine for win, macOS for mac)
//   npm run release -- all           — alias for "linux win mac"

// dotenv silently no-ops when .env is missing (CI case).
try { require('dotenv').config(); } catch { /* dotenv not installed in some CI images — ignore */ }

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const required = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET'];
for (const k of required) {
  if (!process.env[k]) {
    console.error('Missing ' + k + (process.env.CI ? ' env var (CI: set as a repo secret).' : ' in .env (see .env.example).'));
    process.exit(1);
  }
}

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');

// Remove stale files from prior builds so we never upload wrong-version artifacts.
if (fs.existsSync(releaseDir)) {
  for (const entry of fs.readdirSync(releaseDir)) {
    const full = path.join(releaseDir, entry);
    if (fs.statSync(full).isFile()) fs.rmSync(full);
  }
}

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targetsArg = argv.flatMap((t) => (t === 'all' ? ['linux', 'win', 'mac'] : [t]));
// Default: build for the host OS only. Cross-building Windows/Mac from Linux
// requires Wine for Windows and is impossible for Mac — CI matrix handles this.
const targets = targetsArg.length
  ? targetsArg
  : [process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'];

const flagMap = { linux: '-l', win: '-w', mac: '-m' };
const flags = targets.map((t) => {
  if (!flagMap[t]) { console.error('Unknown target: ' + t); process.exit(1); }
  return flagMap[t];
});

console.log('Building for: ' + targets.join(', '));
const build = spawnSync('npx', ['electron-builder', ...flags, '--publish', 'never'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (build.status !== 0) process.exit(build.status);

// Upload installers, blockmaps, and the update manifests. Filename patterns
// match electron-builder's defaults. The .yml manifests are what
// electron-updater polls; everything else is referenced from them.
const uploadable = fs.readdirSync(releaseDir).filter((f) => {
  if (/^latest.*\.yml$/i.test(f)) return true;
  return /\.(exe|dmg|zip|AppImage|deb|blockmap)$/i.test(f);
});

if (!uploadable.length) {
  console.error('Nothing to upload — release/ has no installers or manifests.');
  process.exit(1);
}

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  // R2's TLS cert covers only one level of subdomain (*.r2.cloudflarestorage.com).
  // The SDK default (virtual-hosted-style) puts the bucket name as a further
  // subdomain and fails the TLS handshake — force path-style so the bucket
  // travels in the URL path instead.
  forcePathStyle: true,
  // @aws-sdk/client-s3 v3.729+ adds `x-amz-sdk-checksum-algorithm: CRC32` to
  // PUTs by default. R2 doesn't recognise it, the signature it recomputes
  // doesn't match the SDK's, and uploads fail with the misleading message
  // "Credential sigv4 header should have at least 5 slash-separated parts".
  // Disable the new flexible-checksums middleware to restore plain SigV4.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const contentType = (name) => {
  if (name.endsWith('.yml')) return 'text/yaml';
  if (name.endsWith('.exe')) return 'application/vnd.microsoft.portable-executable';
  if (name.endsWith('.dmg')) return 'application/x-apple-diskimage';
  if (name.endsWith('.zip')) return 'application/zip';
  if (name.endsWith('.AppImage')) return 'application/vnd.appimage';
  if (name.endsWith('.deb')) return 'application/vnd.debian.binary-package';
  return 'application/octet-stream';
};

// Manifests must always be served fresh — otherwise installed clients won't
// see new versions. Versioned binaries are immutable.
const cacheControl = (name) => name.endsWith('.yml')
  ? 'no-cache, no-store, must-revalidate'
  : 'public, max-age=31536000, immutable';

(async () => {
  for (const f of uploadable) {
    const Key = 'releases/' + f;
    const Body = fs.createReadStream(path.join(releaseDir, f));
    const size = fs.statSync(path.join(releaseDir, f)).size;
    process.stdout.write('  upload  ' + f + '  (' + (size / 1024 / 1024).toFixed(1) + ' MB) ...');
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key,
      Body,
      ContentLength: size,
      ContentType: contentType(f),
      CacheControl: cacheControl(f),
    }));
    process.stdout.write(' ok\n');
  }
  console.log('Release uploaded. Installed clients will pick it up on their next update poll.');

  // Optional: poke the marketing site's Cloudflare Pages deploy hook so the
  // /download page rebuilds with the new version and SHA. Skipped silently if
  // the env var isn't set.
  //
  // CI matrix gate: when running across 3 OS runners in parallel we only want
  // ONE rebuild. CI workflows opt-in by setting RELEASE_TRIGGER_SITE_REBUILD=1
  // on exactly one job (the Linux one, conventionally). Local runs always
  // trigger because CI is unset.
  const shouldTriggerSite = process.env.CF_PAGES_DEPLOY_HOOK &&
    (!process.env.CI || process.env.RELEASE_TRIGGER_SITE_REBUILD === '1');
  if (shouldTriggerSite) {
    process.stdout.write('  trigger site rebuild ...');
    try {
      const r = await fetch(process.env.CF_PAGES_DEPLOY_HOOK, { method: 'POST' });
      process.stdout.write(r.ok ? ' ok\n' : ' failed (HTTP ' + r.status + ')\n');
    } catch (err) {
      process.stdout.write(' failed (' + err.message + ')\n');
    }
  }
})().catch((err) => {
  console.error('Upload failed:', err && err.message || err);
  process.exit(1);
});
