import { EventSubscription, requireNativeModule } from 'expo-modules-core';

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
  cookies?: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  userAgent?: string;
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
  /** Pull the latest yt-dlp from GitHub. Optional, not on-init. */
  updateYtDlp(): Promise<void>;
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
 * resetCache.
 */
export function updateYtDlp(): Promise<void> {
  return native.updateYtDlp();
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
  if (u.includes('twitter.com') || u.includes('x.com')) return 'Twitter/X';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('reddit.com') || u.includes('v.redd.it')) return 'Reddit';
  if (u.includes('vimeo.com')) return 'Vimeo';
  if (u.includes('soundcloud.com')) return 'SoundCloud';
  if (u.includes('twitch.tv')) return 'Twitch';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'Facebook';
  return null;
}
