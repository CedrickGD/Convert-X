/**
 * Module-level downloader queue. Mirrors conversionQueue + resizeQueue.
 *
 * Each Download session goes through:
 *   1. probe(url) — yt-dlp --dump-json
 *   2. download(entry, format, quality) — yt-dlp -f <fmt> -o <path>
 *
 * The native module emits onProgress events while download() runs; we
 * relay them to the UI via the registered listener.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';

import * as Downloader from '../../modules/convert-x-downloader/src';

export type DownloadEntry = {
  id: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  webpageUrl: string;
};

export type ProbeResult = {
  site: string | null;
  isPlaylist: boolean;
  entries: DownloadEntry[];
};

let inflight: { sessionId: string; cancel: () => void } | null = null;

export function isDownloading(): boolean {
  return inflight !== null;
}

export function cancelActive(): void {
  if (inflight) {
    Downloader.cancel(inflight.sessionId);
    inflight = null;
  }
}

export async function probeUrl(
  url: string,
  opts?: {
    cookies?: string;
    spotifyClientId?: string;
    spotifyClientSecret?: string;
  }
): Promise<ProbeResult> {
  const site = Downloader.detectSite(url);
  const raw = await Downloader.probe(url, opts);

  // The Kotlin probe surfaces yt-dlp's own error (e.g. "Unsupported URL",
  // missing extractor) via raw.error. Treat it as a thrown error so the
  // UI shows a real message instead of a phantom "Untitled" entry.
  if (typeof (raw as Record<string, unknown>).error === 'string') {
    const stderr = (raw as Record<string, unknown>).stderr as string | undefined;
    const err = (raw as Record<string, unknown>).error as string;
    throw new Error(stderr ? `${err}\n${stderr.split('\n').slice(-3).join('\n')}` : err);
  }

  const isPlaylist = Boolean(raw.isPlaylist);
  const entries: DownloadEntry[] = [];

  if (isPlaylist && Array.isArray(raw.entries)) {
    for (const e of raw.entries as Array<Record<string, unknown>>) {
      entries.push({
        id: String(e.id ?? e.url ?? Date.now()),
        title: String(e.title ?? 'Untitled'),
        thumbnail: typeof e.thumbnail === 'string' ? e.thumbnail : undefined,
        duration: typeof e.duration === 'number' ? e.duration : undefined,
        webpageUrl: String(e.url ?? raw.url ?? url),
      });
    }
  } else {
    entries.push({
      id: String((raw as Record<string, unknown>).id ?? Date.now()),
      title: String((raw as Record<string, unknown>).title ?? 'Untitled'),
      thumbnail: typeof (raw as Record<string, unknown>).thumbnail === 'string'
        ? ((raw as Record<string, unknown>).thumbnail as string)
        : undefined,
      duration: typeof (raw as Record<string, unknown>).duration === 'number'
        ? ((raw as Record<string, unknown>).duration as number)
        : undefined,
      webpageUrl: String((raw as Record<string, unknown>).url ?? url),
    });
  }

  if (entries.length === 0) {
    throw new Error('yt-dlp returned no playable items for this URL.');
  }
  return { site, isPlaylist, entries };
}

export type DownloadResult = {
  outputPath?: string;
  /** Public path (e.g. Movies/Convert-X) when the file was promoted to
   *  the user's gallery via MediaStore. Falls back to outputPath when
   *  the user denies the permission. */
  publicPath?: string;
  cancelled?: boolean;
};

export type BatchDownloadResult = {
  done: number;
  failed: number;
  cancelled: boolean;
  lastPublicPath?: string;
  errors: Array<{ title: string; message: string }>;
};

/**
 * Ask for MediaLibrary permission. Returns true if granted. Cached at
 * module scope so we only ask once per session — Android remembers the
 * decision across launches but checking is free.
 */
let mediaPermissionGranted: boolean | null = null;
export async function ensureMediaPermission(): Promise<boolean> {
  if (mediaPermissionGranted) return true;
  const cur = await MediaLibrary.getPermissionsAsync();
  if (cur.granted) {
    mediaPermissionGranted = true;
    return true;
  }
  const req = await MediaLibrary.requestPermissionsAsync();
  mediaPermissionGranted = req.granted;
  return req.granted;
}

/**
 * Build a yt-dlp format selector that prefers pre-merged streams (no
 * ffmpeg merge step required) and falls back to merging only when that
 * fails. This is what makes downloads work on every site uniformly —
 * YouTube serves separate video+audio streams above 720p, but for most
 * other sites (and YouTube up to 720p) a single pre-merged mp4 exists.
 *
 *   - "best": best video+audio in any container, prefer pre-merged
 *   - "<height>": best ≤ N px, prefer pre-merged mp4
 */
function buildVideoFormat(quality: string | null): string {
  if (!quality || quality === 'best') {
    // bv*+ba/b — yt-dlp's recommended "best video + best audio with merge,
    // fall back to single best" expression. Works without ffmpeg as long
    // as a pre-merged stream is available.
    return 'best[ext=mp4][acodec!=none][vcodec!=none]/best/bv*+ba';
  }
  const h = quality;
  return `best[height<=${h}][ext=mp4][acodec!=none][vcodec!=none]/best[height<=${h}]/bv*[height<=${h}]+ba`;
}

export async function downloadEntry(opts: {
  sessionId: string;
  entry: DownloadEntry;
  audioOnly: boolean;
  format: string | null;
  quality: string | null;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  cookies?: string;
  onProgress: (pct: number) => void;
  /** When true, promote the finished file to the user's gallery via
   *  MediaLibrary. When false, leave the file in app-private storage
   *  only. Default true — most users want the download in their
   *  Gallery / Files app. */
  saveToGallery?: boolean;
}): Promise<DownloadResult> {
  const outDir = `${FileSystem.documentDirectory}downloads`;
  await FileSystem.makeDirectoryAsync(outDir, { intermediates: true }).catch(() => {});

  // yt-dlp template — let yt-dlp pick the final extension. Native side
  // passes --restrict-filenames so the resolved path can't contain
  // characters that break the filesystem (slashes in titles, etc.).
  const outputTemplate = `${outDir.replace(/^file:\/\//, '')}/%(title)s.%(ext)s`;

  const sub = Downloader.addProgressListener((evt) => {
    if (evt.sessionId === opts.sessionId) opts.onProgress(Math.round(evt.percent));
  });

  inflight = { sessionId: opts.sessionId, cancel: () => Downloader.cancel(opts.sessionId) };

  try {
    // Resolve the format selector here so the same logic produces the
    // string we send to yt-dlp regardless of audio/video routing. The
    // native side just forwards `format` as the literal `-f` argument.
    const formatString = opts.audioOnly
      ? null
      : opts.format && opts.format !== 'best'
      ? opts.format
      : buildVideoFormat(opts.quality);

    const result = await Downloader.download(opts.sessionId, {
      url: opts.entry.webpageUrl,
      outputPath: outputTemplate,
      audioOnly: opts.audioOnly,
      audioFormat: opts.audioOnly ? opts.format ?? 'mp3' : undefined,
      format: formatString ?? undefined,
      // Quality is now folded into formatString above — keep it for the
      // native side's audio-quality option but otherwise unused.
      quality: opts.audioOnly ? opts.quality ?? undefined : undefined,
      cookies: opts.cookies,
      spotifyClientId: opts.spotifyClientId,
      spotifyClientSecret: opts.spotifyClientSecret,
    });

    if (result.cancelled || !result.outputPath) return result;

    // Promote to user's gallery via MediaStore. Without this the file
    // sits in app-private storage where users can't easily find it.
    let publicPath: string | undefined;
    if (opts.saveToGallery !== false) {
      try {
        const granted = await ensureMediaPermission();
        if (granted) {
          const uri = result.outputPath.startsWith('file://')
            ? result.outputPath
            : `file://${result.outputPath}`;
          const asset = await MediaLibrary.createAssetAsync(uri);
          const album = await MediaLibrary.getAlbumAsync('Convert-X');
          if (album == null) {
            await MediaLibrary.createAlbumAsync('Convert-X', asset, false);
          } else {
            await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
          }
          publicPath = asset.uri;
        }
      } catch {
        // Best-effort — keep the app-private file as the fallback.
      }
    }

    return { ...result, publicPath };
  } finally {
    sub.remove();
    inflight = null;
  }
}

/**
 * Run multiple downloads sequentially. Reports overall progress
 * (0..100 across the whole batch) so the UI can show a single bar.
 * Errors per item are collected and returned — one failure doesn't
 * abort the rest of the batch.
 */
export async function downloadBatch(opts: {
  sessionId: string;
  entries: DownloadEntry[];
  audioOnly: boolean;
  format: string | null;
  quality: string | null;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  cookies?: string;
  saveToGallery?: boolean;
  /** Called with overall batch percent (0..100) and current item index. */
  onProgress: (overallPct: number, currentIndex: number) => void;
  /** Called when each item starts so the UI can show its title. */
  onItemStart?: (index: number, entry: DownloadEntry) => void;
}): Promise<BatchDownloadResult> {
  const total = opts.entries.length;
  if (total === 0) {
    return { done: 0, failed: 0, cancelled: false, errors: [] };
  }
  let done = 0;
  let failed = 0;
  let lastPublicPath: string | undefined;
  const errors: BatchDownloadResult['errors'] = [];

  for (let i = 0; i < total; i++) {
    if (cancelRequested) {
      cancelRequested = false;
      return { done, failed, cancelled: true, lastPublicPath, errors };
    }
    const entry = opts.entries[i];
    opts.onItemStart?.(i, entry);
    try {
      const r = await downloadEntry({
        sessionId: `${opts.sessionId}-${i}`,
        entry,
        audioOnly: opts.audioOnly,
        format: opts.format,
        quality: opts.quality,
        spotifyClientId: opts.spotifyClientId,
        spotifyClientSecret: opts.spotifyClientSecret,
        cookies: opts.cookies,
        saveToGallery: opts.saveToGallery,
        onProgress: (pct) => {
          // Project the per-item 0..100 into the batch 0..100 band so a
          // 50%-complete item 2 of 4 reads as ((1 * 100) + 50) / 4 = 37.5%.
          const overall = ((i * 100) + pct) / total;
          opts.onProgress(Math.round(overall), i);
        },
      });
      if (r.cancelled) {
        return { done, failed, cancelled: true, lastPublicPath, errors };
      }
      done += 1;
      if (r.publicPath) lastPublicPath = r.publicPath;
    } catch (e) {
      failed += 1;
      errors.push({
        title: entry.title,
        message: e instanceof Error ? e.message : String(e),
      });
      // Keep going — a single bad item shouldn't kill a 30-track playlist.
    }
  }
  return { done, failed, cancelled: false, lastPublicPath, errors };
}

// Batch-level cancel: cancel the active item AND skip the rest.
let cancelRequested = false;
export function cancelBatch(): void {
  cancelRequested = true;
  cancelActive();
}
