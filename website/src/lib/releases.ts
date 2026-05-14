// Build-time fetcher for the release manifests on Cloudflare R2.
// electron-updater writes one YAML per OS family next to the installers; we
// read those YAMLs at site-build time and bake the version / file metadata
// directly into the HTML so the runtime ships zero JS for it.
//
// If R2 is unreachable (offline dev, no network) we return a fallback shape
// so `npm run dev` and `npm run build` still succeed.

import { load as yamlLoad } from 'js-yaml';

const R2_BASE = 'https://pub-d098ab4c32934fd196eb5acec30a1f42.r2.dev/releases';

export type Platform = 'mac' | 'windows' | 'linux';
export type Arch = 'x64' | 'arm64';

export interface ReleaseFile {
  platform: Platform;
  arch: Arch;
  filename: string;
  url: string;
  /** Bytes. May be 0 if the manifest didn't carry the field. */
  size: number;
  /** SHA-512 from electron-updater. Note: NOT sha256. */
  sha512: string;
  /** "AppImage" | "deb" | "dmg" | "zip" | "exe" */
  kind: string;
}

export interface ReleaseInfo {
  version: string;
  releasedAt: string | null;
  files: ReleaseFile[];
}

interface RawManifest {
  version?: string;
  releaseDate?: string;
  path?: string;
  sha512?: string;
  files?: Array<{ url: string; sha512: string; size?: number }>;
}

const fallback: ReleaseInfo = {
  version: '0.1.0',
  releasedAt: null,
  files: [],
};

function kindFromFilename(name: string): string {
  const m = name.toLowerCase().match(/\.(appimage|deb|dmg|zip|exe)$/);
  return m ? m[1] : '';
}

function archFromFilename(name: string): Arch {
  return /arm64|aarch64/i.test(name) ? 'arm64' : 'x64';
}

async function fetchManifest(file: string): Promise<RawManifest | null> {
  try {
    const res = await fetch(`${R2_BASE}/${file}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    return yamlLoad(text) as RawManifest;
  } catch {
    return null;
  }
}

export async function getReleaseInfo(): Promise<ReleaseInfo> {
  const [linux, mac, win] = await Promise.all([
    fetchManifest('latest-linux.yml'),
    fetchManifest('latest-mac.yml'),
    fetchManifest('latest.yml'),
  ]);

  if (!linux && !mac && !win) return fallback;

  const version = linux?.version || mac?.version || win?.version || fallback.version;
  const releasedAt = linux?.releaseDate || mac?.releaseDate || win?.releaseDate || null;
  const files: ReleaseFile[] = [];

  const add = (manifest: RawManifest | null, platform: Platform) => {
    if (!manifest?.files?.length) return;
    for (const f of manifest.files) {
      const filename = f.url;
      const kind = kindFromFilename(filename);
      if (!kind) continue;
      // Filter to the user-facing installer types only — drop blockmaps,
      // diff files, and (on macOS) the zip used solely for delta updates.
      if (platform === 'mac' && kind === 'zip') continue;
      files.push({
        platform,
        arch: archFromFilename(filename),
        filename,
        url: `${R2_BASE}/${filename}`,
        size: f.size || 0,
        sha512: f.sha512 || '',
        kind,
      });
    }
  };

  add(linux, 'linux');
  add(mac, 'mac');
  add(win, 'windows');

  return { version, releasedAt, files };
}

export function formatBytes(n: number): string {
  if (!n) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function platformLabel(p: Platform): string {
  return p === 'mac' ? 'macOS' : p === 'windows' ? 'Windows' : 'Linux';
}

export function kindLabel(k: string): string {
  return ({
    appimage: 'AppImage',
    deb: '.deb',
    dmg: '.dmg',
    exe: 'Installer',
    zip: '.zip',
  } as Record<string, string>)[k] || k;
}
