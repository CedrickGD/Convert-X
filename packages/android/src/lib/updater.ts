/**
 * Self-update from GitHub Releases — for sideloaded builds.
 *
 * Flow:
 *   1. checkForUpdate() — fetch /releases/latest, semver-compare the tag
 *      against pkg.version, pick an ABI-matched APK asset.
 *   2. downloadAndInstall(info) — download the APK to cache, then hand
 *      off to the Android system installer via ACTION_VIEW + FileProvider
 *      (see modules/convert-x-ffmpeg installApk).
 *
 * Idempotent: in-flight checks/downloads are de-duped so double-taps are
 * harmless.
 */

import * as FileSystem from 'expo-file-system/legacy';

import { getSupportedAbis, installApk } from '../../modules/convert-x-ffmpeg/src';
import pkg from '../../package.json';

// Releases now live in the unified Convert-X monorepo, which holds BOTH
// desktop (desktop-v*, MSI) and android (v*, APK) releases — so we fetch the
// release LIST and pick the newest one that has an ABI-matched APK asset.
const RELEASES_API =
  'https://api.github.com/repos/CedrickGD/Convert-X/releases?per_page=30';

export type UpdateInfo = {
  version: string;
  releaseNotes: string;
  apkUrl: string;
  apkSize: number;
  publishedAt: string;
};

type GhAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

type GhRelease = {
  tag_name: string;
  body: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
  assets: GhAsset[];
};

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  return 0;
}

// Exact asset names published by android-release.yml. The 32-bit APK is published as
// `app-armv7-release.apk` (no "armeabi" substring) on purpose: clients <= v0.8.2 sort
// SUPPORTED_ABIS longest-first and would try "armeabi-v7a" before "arm64-v8a",
// silently moving arm64 phones to the 32-bit build.
const ASSETS_FOR_ABI: Record<string, string[]> = {
  'arm64-v8a': ['app-arm64-v8a-release.apk'],
  'armeabi-v7a': ['app-armv7-release.apk', 'app-armeabi-v7a-release.apk'],
  'x86_64': ['app-x86_64-release.apk'],
  'x86': ['app-x86-release.apk'],
};

function pickAssetForAbi(assets: GhAsset[], abis: string[]): GhAsset | null {
  const byName = new Map(assets.map((a) => [a.name.toLowerCase(), a] as const));
  // Build.SUPPORTED_ABIS is in device-preference order (64-bit first on a 64-bit
  // phone). Walk it IN ORDER, never re-sort: a 64-bit phone always gets arm64
  // (and self-heals a mistaken 32-bit install); a 32-bit-userspace phone, whose
  // list has no arm64-v8a, only ever gets armv7.
  for (const abi of abis) {
    for (const name of ASSETS_FOR_ABI[abi] ?? []) {
      const hit = byName.get(name);
      if (hit) return hit;
    }
  }
  return assets.find((a) => /universal/i.test(a.name) && a.name.toLowerCase().endsWith('.apk')) ?? null;
}

let inflightCheck: Promise<UpdateInfo | null> | null = null;
let inflightDownload: Promise<void> | null = null;

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (inflightCheck) return inflightCheck;
  inflightCheck = (async () => {
    try {
      const res = await fetch(RELEASES_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!res.ok) return null;
      const rels = (await res.json()) as GhRelease[];

      const abis = await getSupportedAbis();
      // The list is newest-first. Take the newest published release that has an
      // APK matching this device's ABI — this skips desktop (MSI) releases that
      // share the same repo.
      let rel: GhRelease | null = null;
      let asset: GhAsset | null = null;
      for (const r of rels) {
        if (r.draft || r.prerelease) continue;
        const a = pickAssetForAbi(r.assets, abis);
        if (a) {
          rel = r;
          asset = a;
          break;
        }
      }
      if (!rel || !asset) return null;

      const latest = rel.tag_name.replace(/^v/, '');
      if (cmpSemver(latest, pkg.version) <= 0) return null;

      return {
        version: latest,
        releaseNotes: rel.body ?? '',
        apkUrl: asset.browser_download_url,
        apkSize: asset.size,
        publishedAt: rel.published_at,
      };
    } catch {
      return null;
    } finally {
      // Allow re-check on next user tap; result is fresh after this turn.
      inflightCheck = null;
    }
  })();
  return inflightCheck;
}

export function downloadAndInstall(
  info: UpdateInfo,
  onProgress: (pct: number) => void
): Promise<void> {
  if (inflightDownload) return inflightDownload;

  inflightDownload = (async () => {
    const cacheDir = FileSystem.cacheDirectory;
    if (!cacheDir) throw new Error('No cache directory available');
    const target = `${cacheDir}update-${info.version}.apk`;

    await FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});

    const dl = FileSystem.createDownloadResumable(
      info.apkUrl,
      target,
      {},
      (p) => {
        if (p.totalBytesExpectedToWrite > 0) {
          const pct = Math.round(
            (p.totalBytesWritten / p.totalBytesExpectedToWrite) * 100
          );
          onProgress(pct);
        }
      }
    );

    const result = await dl.downloadAsync();
    if (!result || !result.uri) throw new Error('Download failed');

    // Integrity guard: a flaky connection can resolve a truncated download as
    // "success". Verify the bytes match the release asset size before handing
    // a half-written APK to the system installer (which would otherwise fail
    // with a confusing "app not installed").
    if (info.apkSize > 0) {
      const dlInfo = await FileSystem.getInfoAsync(result.uri);
      const size = dlInfo.exists && 'size' in dlInfo ? dlInfo.size ?? 0 : 0;
      if (size !== info.apkSize) {
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
        throw new Error(
          `Update download was incomplete (${size} of ${info.apkSize} bytes). ` +
            'Check your connection and try again.'
        );
      }
    }

    await installApk(result.uri);
  })().finally(() => {
    inflightDownload = null;
  });

  return inflightDownload;
}
