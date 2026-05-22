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

const RELEASES_API =
  'https://api.github.com/repos/CedrickGD/Convert-X-Android-APK/releases/latest';

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

function pickAssetForAbi(assets: GhAsset[], abis: string[]): GhAsset | null {
  // ABI names in our release filenames look like `app-arm64-v8a-release.apk`
  // — match by lowercased substring, longest first so `arm64-v8a` doesn't
  // accidentally match the bare `arm64` prefix of something else.
  const sortedAbis = [...abis].sort((a, b) => b.length - a.length);
  for (const abi of sortedAbis) {
    const hit = assets.find(
      (a) =>
        a.name.toLowerCase().includes(abi.toLowerCase()) &&
        a.name.toLowerCase().endsWith('.apk')
    );
    if (hit) return hit;
  }
  return (
    assets.find((a) => /universal/i.test(a.name) && a.name.endsWith('.apk')) ??
    null
  );
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
      const rel = (await res.json()) as GhRelease;
      if (rel.draft || rel.prerelease) return null;

      const latest = rel.tag_name.replace(/^v/, '');
      if (cmpSemver(latest, pkg.version) <= 0) return null;

      const abis = await getSupportedAbis();
      const asset = pickAssetForAbi(rel.assets, abis);
      if (!asset) return null;

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

    await installApk(result.uri);
  })().finally(() => {
    inflightDownload = null;
  });

  return inflightDownload;
}
