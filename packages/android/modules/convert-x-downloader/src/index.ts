import { EventSubscription, requireNativeModule } from 'expo-modules-core';
import { PermissionsAndroid, Platform } from 'react-native';

/**
 * yt-dlp bridge — probe / download / cancel.
 *
 * The native side handles Python + yt-dlp init (one-time, ~5-10s on first
 * call). All progress comes through the `onProgress` event keyed by the JS
 * `sessionId` you pass into `download(...)`.
 */

export type ProbeOptions = {
  cookies?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  userAgent?: string;
};

export type DownloadOptions = {
  url: string;
  /** Absolute output path with a yt-dlp template, e.g.
   *  `/data/.../%(title)s.%(ext)s`. */
  outputPath: string;
  /** yt-dlp `-f` expression. Optional — defaults to best. */
  format?: string;
  /** Convenience for `--audio-quality` (yt-dlp 0-10 string) OR a height
   *  cap like "1080" (translated to a bestvideo[height<=N] expression on
   *  the native side). */
  quality?: string;
  /** Audio-only download (`-x`). */
  audioOnly?: boolean;
  /** When audioOnly, the target audio container (mp3, m4a, opus, flac…). */
  audioFormat?: string;
  /** 1-based yt-dlp `--playlist-items` selector. Required to download a
   *  single child of an Instagram/TikTok carousel whose entries share the
   *  parent post URL — without it every "item" resolves to the same file. */
  playlistItems?: string;
  cookies?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  userAgent?: string;
};

export type UpdateResult = {
  /** DONE (installed a new build), ALREADY_UP_TO_DATE, or AVAILABLE
   *  (checkOnly: a newer release exists, nothing was downloaded). */
  status?: string;
  /** Installed yt-dlp version after the call, e.g. "2026.10.26". */
  version?: string | null;
  /** Newest stable release tag on GitHub. */
  latest?: string | null;
};

export type UpdateOptions = {
  /** Re-download even when the installed version already matches. */
  force?: boolean;
  /** Only resolve the latest release; never download. */
  checkOnly?: boolean;
};

export type EngineVersion = {
  /** Installed yt-dlp version read from the zipapp (null if unreadable). */
  version: string | null;
  /** Epoch ms of the last successful in-app update, 0 if never. */
  updatedAt: number;
};

export type WebFetchOptions = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  referrer?: string;
  userAgent?: string;
  timeoutMs?: number;
  /** `replace` installs exactly `cookies` for the URL's origin (expiring
   *  everything else the WebView jar holds for it); `keep` sends the jar
   *  as-is. */
  cookieMode: 'replace' | 'keep';
  cookies: Array<{ name: string; value: string; domain?: string }>;
  maxBodyBytes?: number;
};

export type WebFetchResult = {
  status: number;
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  body: string;
  /** The WebView jar's `name=value; …` string for the origin afterwards. */
  cookies: string;
};

export type SaveToGalleryResult = {
  /** content:// URI (or file:// on API < 29) of the published copy. */
  uri: string;
  /** Human-readable location, e.g. "Movies/Convert-X/clip.mp4". */
  publicPath: string;
};

export type ProbeResult = {
  isPlaylist: boolean;
  /** Raw yt-dlp JSON output — caller picks which fields to use. */
  [k: string]: unknown;
};

export type ProgressEvent = {
  sessionId: string;
  percent: number;
  etaSeconds: number;
  line: string;
};

interface NativeModule {
  init(): Promise<void>;
  /** Wipe extracted Python / yt-dlp cache and re-init from the APK
   *  payload. Use to recover from a corrupted yt-dlp.zip. */
  resetCache(): Promise<void>;
  /** Pull the latest yt-dlp from GitHub (release redirect + asset
   *  download, no REST API). Optional, not on-init. */
  updateYtDlp(opts: UpdateOptions): Promise<UpdateResult>;
  /** Installed yt-dlp version straight from the zipapp on disk. */
  getYtDlpVersion(): Promise<EngineVersion>;
  /** HTTP request through a hidden Android WebView (real Chromium TLS). */
  webFetch(opts: WebFetchOptions): Promise<WebFetchResult>;
  /** Publish a finished file into the gallery via a MediaStore insert the
   *  app owns — no per-file consent dialog, clean display name. */
  saveToGallery(filePath: string, displayName: string): Promise<SaveToGalleryResult>;
  probe(url: string, opts: ProbeOptions | null): Promise<string>;
  download(sessionId: string, opts: DownloadOptions): Promise<{
    outputPath?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    cancelled?: boolean;
  }>;
  cancel(sessionId: string): void;
  addListener(eventName: 'onProgress' | 'onStage'): void;
  removeListeners(count: number): void;
}

const native = requireNativeModule<NativeModule>('ConvertXDownloader');

/**
 * Force-init the bundled Python + yt-dlp runtime. Idempotent. The first
 * call extracts ~30 MB into the app's private storage.
 */
export function init(): Promise<void> {
  return native.init();
}

/**
 * Run `yt-dlp --dump-json` against the URL. Returns parsed JSON.
 */
export async function probe(url: string, opts?: ProbeOptions): Promise<ProbeResult> {
  const raw = await native.probe(url, opts ?? null);
  return JSON.parse(raw) as ProbeResult;
}

export function download(
  sessionId: string,
  opts: DownloadOptions
): Promise<{ outputPath?: string; exitCode?: number; cancelled?: boolean }> {
  return native.download(sessionId, opts);
}

export function cancel(sessionId: string): void {
  native.cancel(sessionId);
}

/**
 * Nuke the extracted Python + yt-dlp cache and re-init from the bundled
 * APK payload. Recovery path when a prior auto-update left the zip in a
 * state python's zipimport refuses to load.
 */
export function resetCache(): Promise<void> {
  return native.resetCache();
}

/**
 * Pull the latest yt-dlp from GitHub. Explicit user action — not run on
 * init, since a partial download corrupted the bundled binary on real
 * devices. If this throws, the next probe / download auto-recovers via
 * resetCache. Resolves with the real outcome so the UI can tell
 * "updated to X" apart from "already up to date".
 */
export function updateYtDlp(opts: UpdateOptions = {}): Promise<UpdateResult> {
  return native.updateYtDlp(opts);
}

/** Installed yt-dlp version (read from the zipapp's own version.py). */
export function getYtDlpVersion(): Promise<EngineVersion> {
  return native.getYtDlpVersion();
}

/**
 * Perform an HTTP request from a hidden Android System WebView. Needed
 * for sites that fingerprint the TLS client (Instagram): the WebView is
 * the one HTTP stack on the device that IS a browser. Rejects with code
 * WEBVIEW_UNAVAILABLE when the device has no usable WebView — callers
 * fall back to fetch(). Absent on native builds older than the bridge,
 * so callers must feature-test `typeof webFetch === 'function'`.
 */
export function webFetch(opts: WebFetchOptions): Promise<WebFetchResult> {
  return native.webFetch(opts);
}

/**
 * On API < 29 (Android 9 and older) a MediaStore insert into the public
 * Pictures/Movies/Download tree still requires the legacy
 * WRITE_EXTERNAL_STORAGE runtime permission — scoped storage (which needs
 * no permission) only arrived in API 29. Request it once, up front, so the
 * save doesn't fail deep inside the native module. A no-op on API 29+ and
 * on non-Android platforms.
 */
async function ensureLegacyWriteAccess(): Promise<void> {
  if (Platform.OS !== 'android' || Number(Platform.Version) >= 29) return;
  const perm = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
  if (await PermissionsAndroid.check(perm)) return;
  if ((await PermissionsAndroid.request(perm)) !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new Error('Storage permission is needed to save to the gallery on Android 9 and older.');
  }
}

/**
 * Publish a finished file into the user's gallery. Uses a MediaStore
 * insert owned by this app — no system consent dialog on API 29+, and the
 * gallery shows exactly `displayName` instead of a cache-file name. On
 * older Android the legacy storage permission is requested first.
 */
export async function saveToGallery(
  filePath: string,
  displayName: string
): Promise<SaveToGalleryResult> {
  await ensureLegacyWriteAccess();
  return native.saveToGallery(filePath, displayName);
}

export function addProgressListener(
  cb: (event: ProgressEvent) => void
): EventSubscription {
  const emitter = native as unknown as {
    addListener: (name: 'onProgress', listener: (e: ProgressEvent) => void) => EventSubscription;
  };
  return emitter.addListener('onProgress', cb);
}

/**
 * Detect the upstream site from the URL. Used by the UI to label the
 * source chip. Order matters — pick the most specific match.
 */
export function detectSite(url: string): string | null {
  if (!url) return null;
  const u = url.toLowerCase();
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('spotify.com') || u.includes('open.spotify.com')) return 'Spotify';
  if (u.includes('instagram.com')) return 'Instagram';
  // Discord sticker-stealer sources — checked before the loose x.com match
  // below so a CDN host can never be mislabeled.
  if (
    u.includes('discord.com') ||
    u.includes('discordapp.com') ||
    u.includes('discordapp.net')
  )
    return 'Discord';
  if (u.includes('tenor.com')) return 'Tenor';
  if (u.includes('giphy.com')) return 'Giphy';
  if (u.includes('klipy.com') || u.includes('klipy.co')) return 'Klipy';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'Twitter/X';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('reddit.com') || u.includes('v.redd.it')) return 'Reddit';
  if (u.includes('vimeo.com')) return 'Vimeo';
  if (u.includes('soundcloud.com')) return 'SoundCloud';
  if (u.includes('twitch.tv')) return 'Twitch';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'Facebook';
  return null;
}
