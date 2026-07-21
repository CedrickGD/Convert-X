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

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import * as Downloader from '../../modules/convert-x-downloader/src';
import { hasCookiesForDomain, resolveCookiesPath } from './cookies';
import { isInstagramPostUrl, probeInstagramAnonymous } from './instagramScraper';

// Keyed by yt-dlp release cadence (year.month) rather than a one-shot
// boolean: extractors rot within weeks when sites change their APIs, so
// re-check for a fresh yt-dlp once per calendar month instead of exactly
// once in the app's lifetime.
const YTDLP_FRESHNESS_KEY = '@convertx/ytdlp-freshness';
function currentFreshnessStamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}`;
}

/** What the probe determined a downloadable item actually is. Drives the
 *  adaptive options UI (an image post must not offer a "video/audio"
 *  choice) and the per-item download strategy. */
export type DownloadMediaType = 'video' | 'audio' | 'image';

export type DownloadEntry = {
  id: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  /** Detected content type. Absent = unknown (treated as video). */
  mediaType?: DownloadMediaType;
  webpageUrl: string;
  /** 1-based playlist position, set for carousel/story children that have
   *  no URL of their own (webpageUrl is the parent post). Downloads pass
   *  it to yt-dlp as --playlist-items so each child fetches its own
   *  media instead of the whole carousel resolving to one file N times. */
  playlistIndex?: number;
  /** Direct CDN URL (set by the anonymous Instagram scraper). When
   *  present, downloadEntry bypasses yt-dlp and fetches this URL
   *  directly — necessary because Instagram's API is locked but its
   *  public CDN media URLs are not. */
  directUrl?: string;
  /** Set by the anonymous Instagram scraper when the post is a carousel but
   *  only the first item is retrievable without login. */
  partialCarousel?: boolean;
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

let ytdlpUpdateInflight: Promise<{
  ok: boolean;
  status?: string;
  version?: string | null;
  error?: string;
}> | null = null;

export async function updateYtDlp(): Promise<{
  ok: boolean;
  /** DONE = new version installed, ALREADY_UP_TO_DATE = nothing to do. */
  status?: string;
  /** Installed yt-dlp version after the call. */
  version?: string | null;
  error?: string;
}> {
  if (ytdlpUpdateInflight) return ytdlpUpdateInflight;
  const run = (async () => {
    try {
      await Downloader.init();
      const result = await Downloader.updateYtDlp();
      return { ok: true, status: result?.status, version: result?.version };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })();
  ytdlpUpdateInflight = run;
  try {
    return await run;
  } finally {
    ytdlpUpdateInflight = null;
  }
}

export async function runFirstLaunchYtDlpUpdate(): Promise<void> {
  try {
    const stamp = await AsyncStorage.getItem(YTDLP_FRESHNESS_KEY);
    if (stamp === currentFreshnessStamp()) return;
    const result = await updateYtDlp();
    if (result.ok) {
      await AsyncStorage.setItem(YTDLP_FRESHNESS_KEY, currentFreshnessStamp());
    }
  } catch {
    // Silent — will retry on next launch. Probe-time corruption recovery
    // already handles a half-applied yt-dlp.zip from a killed update.
  }
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'avif', 'gif'];
const AUDIO_CONTAINERS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'ogg', 'vorbis', 'wma'];

/**
 * Classify a yt-dlp info entry as video / audio / image. Used to drive the
 * adaptive options UI and per-item download strategy. yt-dlp reports
 * `vcodec`/`acodec` = "none" (and no duration) for still images; audio-only
 * sources (SoundCloud, Bandcamp) have an acodec but no vcodec.
 */
function detectMediaType(e: Record<string, unknown>): DownloadMediaType {
  const ext = String(e.ext ?? '').toLowerCase();
  const vcodec = String(e.vcodec ?? '').toLowerCase();
  const acodec = String(e.acodec ?? '').toLowerCase();
  const hasVideo = vcodec !== '' && vcodec !== 'none';
  const hasAudio = acodec !== '' && acodec !== 'none';
  const hasDuration = typeof e.duration === 'number' && (e.duration as number) > 0;

  if (hasVideo) return 'video';
  if (IMAGE_EXTS.includes(ext)) return 'image';
  if (hasAudio || hasDuration) return 'audio';
  // No video codec, not a known image ext, no audio track, no timeline —
  // this is how yt-dlp presents a still image (vcodec/acodec both "none").
  if (vcodec === 'none' && acodec === 'none') return 'image';
  // Genuinely unknown → let the video format ladder try.
  return 'video';
}

/**
 * Reduce a page URL to its host+path identity so parent/child comparison
 * survives the query junk share links carry (?igsh=, ?si=, ?img_index=…).
 * Query params are dropped deliberately — see the selfContained comment.
 */
function canonicalUrlKey(u: string): string {
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    return u;
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
  // On-disk cookies.txt is the source of truth for "logged in" — fall back
  // to it when the caller's cookiesPath is momentarily empty (hydration
  // race), so a logged-in user's first private-post download doesn't fail
  // with "login required".
  const cookies = opts?.cookies || (await resolveCookiesPath());
  const resolvedOpts = { ...opts, cookies };

  // Anonymous Instagram path. Hits the public embed endpoint that
  // snapinsta.to and similar downloaders use — no auth required for
  // public posts. Carousels resolve all children. Skipped only when the
  // user has INSTAGRAM cookies specifically (a private post's embed is a
  // login wall, so the cookied path is better). Gating on the shared
  // cookies file's mere existence would wrongly skip this for a user
  // logged into an unrelated platform (e.g. YouTube) — cookies.txt is
  // one file across all platforms.
  if (isInstagramPostUrl(url) && !(await hasCookiesForDomain('instagram.com'))) {
    try {
      return await probeInstagramAnonymous(url);
    } catch {
      // Fall through to yt-dlp.
    }
  }

  const site = Downloader.detectSite(url);
  const raw = await Downloader.probe(url, resolvedOpts);

  // The Kotlin probe surfaces yt-dlp's own error (e.g. "Unsupported URL",
  // missing extractor) via raw.error. Treat it as a thrown error so the
  // UI shows a real message instead of a phantom "Untitled" entry.
  if (typeof (raw as Record<string, unknown>).error === 'string') {
    const r = raw as Record<string, unknown>;
    const err = r.error as string;
    const stderr = typeof r.stderr === 'string' ? r.stderr : '';
    const stdout = typeof r.stdout === 'string' ? r.stdout : '';
    // Last 3 non-empty lines from stderr, or stdout if stderr is empty,
    // or the bare error string as a last resort.
    const tail = (text: string) =>
      text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .slice(-3)
        .join(' · ');
    const stderrTail = tail(stderr);
    const stdoutTail = tail(stdout);
    const detail =
      stderrTail && stderrTail !== '(empty stderr)' ? stderrTail :
      stdoutTail && stdoutTail !== '(empty stdout)' ? stdoutTail :
      '';
    throw new Error(detail ? `${err}\n${detail}` : err);
  }

  const isPlaylist = Boolean(raw.isPlaylist);
  const entries: DownloadEntry[] = [];

  if (isPlaylist && Array.isArray(raw.entries)) {
    const parentUrl = String(raw.url ?? url);
    (raw.entries as Array<Record<string, unknown>>).forEach((e, i) => {
      // An entry that carries its own distinct URL (YouTube playlist
      // videos) downloads directly. Carousel/story children (Instagram,
      // TikTok, Reddit) share the parent post URL — their only usable
      // identity is the playlist position, which the download step turns
      // into --playlist-items so each child fetches its own media.
      //
      // Only webpage_url / original_url qualify: a full-info entry's `url`
      // is the resolved MEDIA url (an expiring CDN link), and downloading
      // that instead of the page bricks the format selector. An entry
      // with neither field safely falls back to parent + --playlist-items.
      const ownUrl =
        typeof e.webpage_url === 'string' && e.webpage_url.length > 0
          ? e.webpage_url
          : typeof e.original_url === 'string' && e.original_url.length > 0
          ? e.original_url
          : undefined;
      // Compare canonical identities, not raw strings: share links carry
      // query junk (?igsh=, ?si=, ?img_index=) that makes a carousel
      // child's clean webpage_url differ textually from the pasted parent
      // URL. Getting this wrong flips the child to "self-contained", so
      // downloading "item 6" re-fetches the whole carousel and saves the
      // wrong file. Wrongly classifying as child merely costs one extra
      // playlist expansion, so the aggressive (query-stripping) compare
      // is the safe direction.
      const selfContained =
        ownUrl !== undefined && canonicalUrlKey(ownUrl) !== canonicalUrlKey(parentUrl);
      entries.push({
        id: String(e.id ?? ownUrl ?? `${parentUrl}#${i + 1}`),
        title: String(e.title ?? 'Untitled'),
        thumbnail: typeof e.thumbnail === 'string' ? e.thumbnail : undefined,
        duration: typeof e.duration === 'number' ? e.duration : undefined,
        mediaType: detectMediaType(e),
        webpageUrl: selfContained ? ownUrl : parentUrl,
        playlistIndex: selfContained
          ? undefined
          : typeof e.playlist_index === 'number'
          ? e.playlist_index
          : i + 1,
      });
    });
  } else {
    const single = raw as Record<string, unknown>;
    entries.push({
      id: String(single.id ?? Date.now()),
      title: String(single.title ?? 'Untitled'),
      thumbnail: typeof single.thumbnail === 'string' ? single.thumbnail : undefined,
      duration: typeof single.duration === 'number' ? single.duration : undefined,
      mediaType: detectMediaType(single),
      // NEVER single.url here: when yt-dlp's probe resolves a premerged
      // format (X, TikTok, cookied Instagram — and YouTube whenever no
      // JS runtime is available, i.e. always on-device with 2026.06+
      // yt-dlp), the top-level `url` is the selected format's expiring
      // CDN link. Feeding that back into the download step routes it
      // through the generic extractor, whose single format has no
      // vcodec/acodec metadata, so every term of the -f chain filters
      // it out → "Requested format is not available" on every video.
      webpageUrl: String(single.webpage_url ?? single.original_url ?? url),
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
  // CRITICAL: every term in the fallback chain must require a video codec
  // (`vcodec!=none` or `bv*`). The previous chain had a bare `best`
  // fallback which on modern YouTube resolves to an audio-only m4a track
  // (because that's the highest-bitrate single stream available once the
  // pre-merged 720p mp4 stops being served). With this chain, the user
  // who picked "Video" can never get an audio-only file.
  if (!quality || quality === 'best') {
    return 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba';
  }
  const h = quality;
  return `best[height<=${h}][ext=mp4][acodec!=none][vcodec!=none]/best[height<=${h}][acodec!=none][vcodec!=none]/bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba`;
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
   *  MediaStore. When false, leave the file in app-private storage
   *  only. Default true — most users want the download in their
   *  Gallery / Files app. */
  saveToGallery?: boolean;
  /** Suffix output names with the media id. Set for batches — carousel
   *  children often share one title, and identical names in the shared
   *  downloads dir make yt-dlp skip every item after the first. */
  dedupeNames?: boolean;
}): Promise<DownloadResult> {
  const outDir = `${FileSystem.documentDirectory}downloads`;
  await FileSystem.makeDirectoryAsync(outDir, { intermediates: true }).catch(() => {});

  // yt-dlp template — let yt-dlp pick the final extension. Native side
  // passes --restrict-filenames so the resolved path can't contain
  // characters that break the filesystem (slashes in titles, etc.).
  const nameTemplate =
    opts.dedupeNames || opts.entry.playlistIndex != null
      ? '%(title)s-%(id)s.%(ext)s'
      : '%(title)s.%(ext)s';
  const outputTemplate = `${outDir.replace(/^file:\/\//, '')}/${nameTemplate}`;

  // Direct-URL fast path. The anonymous Instagram scraper resolves
  // each carousel child to a CDN URL — we can fetch those over plain
  // HTTPS without involving yt-dlp at all. Saves a Python + yt-dlp
  // round trip and works for posts that yt-dlp can't see anonymously.
  if (opts.entry.directUrl) {
    return downloadDirect({
      sessionId: opts.sessionId,
      entry: opts.entry,
      directUrl: opts.entry.directUrl,
      outDir: outDir.replace(/^file:\/\//, ''),
      onProgress: opts.onProgress,
      saveToGallery: opts.saveToGallery !== false,
    });
  }

  const sub = Downloader.addProgressListener((evt) => {
    // The library reports -1 for lines without a parsable percent —
    // don't let those knock a progressing bar back to the left edge.
    if (evt.sessionId === opts.sessionId && evt.percent >= 0) {
      opts.onProgress(Math.min(100, Math.round(evt.percent)));
    }
  });

  inflight = { sessionId: opts.sessionId, cancel: () => Downloader.cancel(opts.sessionId) };

  try {
    // Per-item strategy keys off the detected media type so the UI's
    // video/audio toggle can't produce an impossible request:
    //   - image  → no `-f` selector at all (a video selector matches
    //              nothing on a photo and yt-dlp would error)
    //   - audio source (SoundCloud track) → always extract audio, even if
    //              the user left the toggle on "Video"
    //   - video  → honor the user's video/audio choice
    const kind = opts.entry.mediaType ?? 'video';
    const audioOnly = kind === 'image' ? false : kind === 'audio' ? true : opts.audioOnly;

    // Resolve the format selector here so the same logic produces the
    // string we send to yt-dlp regardless of audio/video routing. The
    // native side just forwards `format` as the literal `-f` argument.
    const formatString =
      kind === 'image'
        ? null
        : audioOnly
        ? null
        : opts.format && opts.format !== 'best'
        ? opts.format
        : buildVideoFormat(opts.quality);

    // When we FORCE audio on an audio-only source, the user's `format` may
    // still hold a video container (mp4/webm) — never hand that to
    // --audio-format. Fall back to mp3 unless it's a real audio container.
    const audioFormat = audioOnly
      ? opts.format && AUDIO_CONTAINERS.includes(opts.format.toLowerCase())
        ? opts.format
        : 'mp3'
      : undefined;

    const result = await Downloader.download(opts.sessionId, {
      url: opts.entry.webpageUrl,
      outputPath: outputTemplate,
      audioOnly,
      audioFormat,
      format: formatString ?? undefined,
      // Quality is now folded into formatString above — the native side
      // only forwards it as --audio-quality. Guard the value: the shared
      // `quality` setting can hold a VIDEO height ("720") left over from
      // a previous video download, and yt-dlp would pass that straight
      // to ffmpeg as -q:a 720 (valid range 0-10), wrecking the encode.
      quality:
        audioOnly && opts.quality && /^(?:\d|10|\d+[kK])$/.test(opts.quality)
          ? opts.quality
          : undefined,
      playlistItems:
        opts.entry.playlistIndex != null ? String(opts.entry.playlistIndex) : undefined,
      cookies: opts.cookies,
      spotifyClientId: opts.spotifyClientId,
      spotifyClientSecret: opts.spotifyClientSecret,
    });

    if (result.cancelled || !result.outputPath) return result;

    // Promote to the user's gallery. The native MediaStore insert is
    // owned by this app, so Android shows no consent dialog — unlike the
    // old expo-media-library album flow, which popped a per-file
    // "May Convert-X modify this file?" prompt on every single save.
    let publicPath: string | undefined;
    if (opts.saveToGallery !== false) {
      try {
        const displayName = result.outputPath.split('/').pop() ?? '';
        const saved = await Downloader.saveToGallery(result.outputPath, displayName);
        publicPath = saved.publicPath;
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
  /** Called after each item finishes successfully (for output history). */
  onItemDone?: (entry: DownloadEntry, result: DownloadResult) => void;
}): Promise<BatchDownloadResult> {
  const total = opts.entries.length;
  if (total === 0) {
    return { done: 0, failed: 0, cancelled: false, errors: [] };
  }
  // Same source-of-truth resolution as probeUrl: use on-disk cookies when
  // the caller's are empty, so a logged-in download never fails for lack of
  // a cookie path that exists on disk.
  const cookies = opts.cookies || (await resolveCookiesPath());
  let done = 0;
  let failed = 0;
  let lastPublicPath: string | undefined;
  const errors: BatchDownloadResult['errors'] = [];

  // A previous batch that was cancelled mid-item leaves cancelRequested set
  // (the r.cancelled early-return below doesn't clear it). Reset here so a
  // fresh batch isn't aborted on iteration 0. See cancelBatch().
  cancelRequested = false;

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
        cookies,
        saveToGallery: opts.saveToGallery,
        dedupeNames: total > 1,
        onProgress: (pct) => {
          // Project the per-item 0..100 into the batch 0..100 band so a
          // 50%-complete item 2 of 4 reads as ((1 * 100) + 50) / 4 = 37.5%.
          const overall = ((i * 100) + pct) / total;
          opts.onProgress(Math.round(overall), i);
        },
      });
      if (r.cancelled) {
        cancelRequested = false;
        return { done, failed, cancelled: true, lastPublicPath, errors };
      }
      done += 1;
      if (r.publicPath) lastPublicPath = r.publicPath;
      opts.onItemDone?.(entry, r);
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

/**
 * Fetch a media URL directly (used for Instagram CDN URLs from the
 * anonymous scraper) and run it through the same MediaStore
 * promotion flow as a yt-dlp download.
 */
async function downloadDirect(opts: {
  sessionId: string;
  entry: DownloadEntry;
  directUrl: string;
  outDir: string;
  onProgress: (pct: number) => void;
  saveToGallery: boolean;
}): Promise<DownloadResult> {
  // Pick an extension by looking at the URL — Instagram CDN URLs
  // always end with `.jpg` / `.mp4` / `.webp` before the query string.
  const urlPath = opts.directUrl.split('?')[0];
  const extMatch = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/);
  const ext = (extMatch?.[1] ?? 'bin').toLowerCase();
  const safeName = opts.entry.title.replace(/[^A-Za-z0-9_\-]/g, '_');
  const outputPath = `${opts.outDir}/${safeName}.${ext}`;
  const fileUri = `file://${outputPath}`;

  // Hold the resumable so a Cancel tap can actually abort the transfer (not
  // just skip to the next item) and we can clean up the partial on abort.
  let dl: ReturnType<typeof FileSystem.createDownloadResumable> | null = null;
  inflight = {
    sessionId: opts.sessionId,
    cancel: () => {
      dl?.cancelAsync().catch(() => {});
    },
  };

  try {
    dl = FileSystem.createDownloadResumable(
      opts.directUrl,
      fileUri,
      {},
      (p) => {
        const total = p.totalBytesExpectedToWrite || 1;
        opts.onProgress(Math.round((p.totalBytesWritten / total) * 100));
      }
    );
    const result = await dl.downloadAsync();
    if (!result?.uri) {
      throw new Error('Direct download produced no file.');
    }

    let publicPath: string | undefined;
    if (opts.saveToGallery) {
      try {
        const saved = await Downloader.saveToGallery(outputPath, `${safeName}.${ext}`);
        publicPath = saved.publicPath;
      } catch {
        // Best-effort — keep the app-private file as the fallback.
      }
    }

    return { outputPath, publicPath };
  } catch (e) {
    // A cancelled or failed transfer leaves a partial file behind.
    await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
    throw e;
  } finally {
    inflight = null;
  }
}
