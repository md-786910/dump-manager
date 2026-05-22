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

const envValue = (key) => String(process.env[key] || '').trim();
const r2 = {
  accessKeyId: envValue('R2_ACCESS_KEY_ID'),
  secretAccessKey: envValue('R2_SECRET_ACCESS_KEY'),
  endpoint: envValue('R2_ENDPOINT').replace(/\/+$/, ''),
  bucket: envValue('R2_BUCKET'),
};

const failConfig = (message) => {
  console.error('Invalid R2 configuration: ' + message);
  if (process.env.CI) {
    console.error('Fix the repository secrets in GitHub Actions: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET.');
  } else {
    console.error('Fix the R2_* values in .env.');
  }
  process.exit(1);
};

if (!/^https:\/\/[a-f0-9]{32}\.(?:(?:eu|fedramp)\.)?r2\.cloudflarestorage\.com$/i.test(r2.endpoint)) {
  failConfig('R2_ENDPOINT must be the S3 API endpoint, e.g. https://<account-id>.r2.cloudflarestorage.com. Do not use the public r2.dev URL or a Cloudflare dashboard/API URL.');
}

if (!/^[a-f0-9]{32}$/i.test(r2.accessKeyId)) {
  failConfig('R2_ACCESS_KEY_ID must be the 32-character R2 S3 Access Key ID from Cloudflare R2 > Manage R2 API Tokens.');
}

if (!/^[a-f0-9]{64}$/i.test(r2.secretAccessKey)) {
  failConfig('R2_SECRET_ACCESS_KEY must be the 64-character R2 S3 Secret Access Key, not a Cloudflare API token.');
}

if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(r2.bucket)) {
  failConfig('R2_BUCKET must be just the bucket name, without slashes or URLs.');
}

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
  shell: true,
  env: process.env,
});
if (build.error) { console.error('electron-builder spawn failed:', build.error.message); process.exit(1); }
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
  endpoint: r2.endpoint,
  // R2's TLS cert covers only one level of subdomain (*.r2.cloudflarestorage.com).
  // The SDK default (virtual-hosted-style) puts the bucket name as a further
  // subdomain and fails the TLS handshake — force path-style so the bucket
  // travels in the URL path instead.
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
  },
});

// R2 does not support AWS's chunked/trailer signing mode. When the SDK receives
// a ReadStream body it automatically sets x-amz-content-sha256 to a STREAMING-*
// value and emits x-amz-trailer / x-amz-checksum-* headers that R2 rejects with
// the misleading "Credential sigv4 header should have at least 5 slash-separated
// parts" error. The real fix is to upload Buffers (below) so the SDK computes the
// SHA256 upfront and signs normally. This middleware is kept as defense-in-depth.
s3.middlewareStack.add(
  (next) => async (args) => {
    const { headers } = args.request;
    for (const key of Object.keys(headers)) {
      if (
        key === 'x-amz-sdk-checksum-algorithm' ||
        key === 'x-amz-trailer' ||
        key.startsWith('x-amz-checksum-')
      ) delete headers[key];
    }
    return next(args);
  },
  { step: 'finalizeRequest', priority: 'low', name: 'stripR2UnsupportedChecksumHeaders' }
);

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
    // Buffer body (not ReadStream) — avoids the SDK's chunked/trailer signing
    // mode that R2 rejects. Files top out at ~115 MB; CI runners have plenty of RAM.
    const Body = fs.readFileSync(path.join(releaseDir, f));
    const size = Body.length;
    process.stdout.write('  upload  ' + f + '  (' + (size / 1024 / 1024).toFixed(1) + ' MB) ...');
    await s3.send(new PutObjectCommand({
      Bucket: r2.bucket,
      Key,
      Body,
      ContentLength: size,
      ContentType: contentType(f),
      CacheControl: cacheControl(f),
    }));
    process.stdout.write(' ok\n');
  }
  console.log('Release uploaded. Installed clients will pick it up on their next update poll.');

  // Print SHA256 checksums for macOS zip files so the Homebrew tap cask can be
  // updated with the correct hashes after each release.
  if (targets.includes('mac')) {
    const crypto = require('node:crypto');
    const macZips = uploadable.filter((f) => /mac.*\.zip$/i.test(f));
    if (macZips.length) {
      console.log('\nHomebrew tap SHA256 checksums (paste into homebrew-tap/Casks/tunnex.rb):');
      for (const f of macZips) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseDir, f))).digest('hex');
        const label = f.includes('arm64') ? 'arm64' : 'x64';
        console.log('  ' + label + ': ' + hash);
      }
    }
  }

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
