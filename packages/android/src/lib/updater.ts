/**
 * Self-update from GitHub Releases — for sideloaded builds.
 *
 * Flow:
 *   1. checkForUpdate() — list releases, semver-compare the newest Android
 *      tag against pkg.version, pick an ABI-matched APK asset.
 *   2. downloadAndInstall(info) — download the APK to cache, then hand
 *      off to the Android system installer via ACTION_VIEW + FileProvider
 *      (see modules/convert-x-ffmpeg installApk).
 *
 * Two sources for step 1. The GitHub REST API is rich (asset sizes, notes)
 * but rate-limited to 60 requests/hour PER IP, and a phone on carrier NAT
 * shares its IP with thousands of users — so it answers HTTP 403 much of
 * the time, which used to read as "You have the latest version". The
 * releases Atom feed and the asset download URLs are ordinary web
 * endpoints with no such limit; they are the fallback (and a HEAD on the
 * asset URL doubles as the ABI check). Only when BOTH fail does the check
 * throw, so the card can say "could not check" instead of lying.
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
const RELEASES_ATOM = 'https://github.com/CedrickGD/Convert-X/releases.atom';
const RELEASE_DOWNLOAD_BASE = 'https://github.com/CedrickGD/Convert-X/releases/download';
const FETCH_TIMEOUT_MS = 15000;

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

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Source 1: the REST API (asset sizes + notes; rate-limited per IP). */
async function checkViaApi(abis: string[]): Promise<UpdateInfo | null> {
  const res = await fetchWithTimeout(RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const rels = (await res.json()) as GhRelease[];

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
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Rough HTML → text for the feed's release notes. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Source 2: the releases Atom feed + a HEAD on the asset URL. No API, no
 * rate limit. Entries are newest-first; a tag with a `-` suffix is a
 * prerelease by this repo's convention (android-release.yml marks exactly
 * those as prerelease), desktop tags are `desktop-v*`, so plain `vX.Y.Z`
 * is an Android release. The HEAD confirms the ABI asset exists and
 * yields its size for the integrity check.
 */
async function checkViaFeed(abis: string[]): Promise<UpdateInfo | null> {
  const res = await fetchWithTimeout(RELEASES_ATOM, {
    headers: { Accept: 'application/atom+xml, application/xml, text/xml' },
  });
  if (!res.ok) throw new Error(`Releases feed HTTP ${res.status}`);
  const xml = await res.text();
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  if (entries.length === 0) throw new Error('Releases feed carried no entries');

  for (const entry of entries) {
    const tag = entry.match(/\/releases\/tag\/([^"<]+)"/)?.[1];
    if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) continue;
    const latest = tag.slice(1);
    // Newest Android release first: if it isn't newer, nothing is.
    if (cmpSemver(latest, pkg.version) <= 0) return null;

    for (const abi of abis) {
      for (const name of ASSETS_FOR_ABI[abi] ?? []) {
        const apkUrl = `${RELEASE_DOWNLOAD_BASE}/${tag}/${name}`;
        try {
          const head = await fetchWithTimeout(apkUrl, { method: 'HEAD' });
          if (!head.ok) continue;
          const size = parseInt(head.headers.get('content-length') ?? '0', 10) || 0;
          return {
            version: latest,
            releaseNotes: htmlToText(
              entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? ''
            ),
            apkUrl,
            apkSize: size,
            publishedAt: entry.match(/<updated>([^<]+)<\/updated>/)?.[1] ?? '',
          };
        } catch {
          // network hiccup on this asset — try the next candidate
        }
      }
    }
    // A newer Android release without an APK for this ABI (e.g. a 32-bit
    // phone looking at an arm64-only release): keep looking at older ones.
  }
  return null;
}

/**
 * Resolve the newest installable release for this device, or null when
 * the installed build is current. Throws when GitHub could not be reached
 * through either source — callers must show "could not check", never
 * "up to date", for that.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (inflightCheck) return inflightCheck;
  inflightCheck = (async () => {
    try {
      const abis = await getSupportedAbis();
      let apiError: unknown = null;
      try {
        return await checkViaApi(abis);
      } catch (e) {
        apiError = e;
      }
      try {
        return await checkViaFeed(abis);
      } catch (feedError) {
        const a = apiError instanceof Error ? apiError.message : String(apiError);
        const f = feedError instanceof Error ? feedError.message : String(feedError);
        throw new Error(`Could not reach GitHub (${a}; ${f})`);
      }
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
