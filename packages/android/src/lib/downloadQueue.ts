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
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import * as Downloader from '../../modules/convert-x-downloader/src';
import { hasCookiesForDomain, resolveCookiesPath } from './cookies';
import { logError } from './errorLog';
import { isInstagramPostUrl, probeInstagramAnonymous } from './instagramScraper';
import {
  instagramProfileToStoriesUrl,
  isInstagramStoryUrl,
  probeInstagramPost,
  probeInstagramStory,
} from './instagramStories';
import { isTwitterStatusUrl, probeTwitterAnonymous } from './twitterScraper';

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
  /** Direct CDN URL (set by the Instagram/Twitter probers). When
   *  present, downloadEntry bypasses yt-dlp and fetches this URL
   *  directly — necessary because those APIs are locked to yt-dlp but
   *  their CDN media URLs are not. */
  directUrl?: string;
  /** All available encodes of a direct video, so the download step can
   *  honor the user's quality cap instead of always taking the largest. */
  variants?: Array<{ url: string; width?: number; height?: number }>;
  /** Set by the anonymous Instagram scraper when the post is a carousel but
   *  only the first item is retrievable without login. */
  partialCarousel?: boolean;
};

export type ProbeResult = {
  site: string | null;
  isPlaylist: boolean;
  entries: DownloadEntry[];
};

/** Direct-CDN failure that carries the HTTP status — the batch layer
 *  distinguishes an expired signed URL (re-probe and retry) from a
 *  genuinely broken one (fail the item). */
export class HttpStatusError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Every in-flight unit (yt-dlp session or direct-CDN transfer) registers
// its cancel closure here. A map, not a single slot: direct-CDN items run
// CONCURRENTLY, and Cancel must abort all of them, not whichever one
// registered last.
const inflightCancels = new Map<string, () => void>();
// True for the whole life of a downloadBatch call — the map alone can't
// answer "is a batch running": cancelActive() clears it synchronously on
// the Cancel tap while the batch loop is still winding down, which is
// exactly the window a re-entrancy guard exists for.
let batchActive = false;

export function isDownloading(): boolean {
  return batchActive || inflightCancels.size > 0;
}

export function cancelActive(): void {
  // Invoke the registered closures, not Downloader.cancel directly: the
  // direct-CDN path (Instagram/Twitter probers) has no native session —
  // its closure aborts the FileSystem transfer, and calling the native
  // cancel with its sessionId would be a silent no-op that lets the
  // "cancelled" download run to completion and report success.
  for (const cancel of inflightCancels.values()) cancel();
  inflightCancels.clear();
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

  // Twitter/X status URLs: yt-dlp errors on pure-photo tweets ("No video
  // could be found in this tweet") — the anonymous syndication prober
  // handles photos, multi-photo posts, and videos alike. Failures
  // (protected/deleted/NSFW-gated tweets) fall through to yt-dlp, which
  // can use the user's cookies.
  if (isTwitterStatusUrl(url)) {
    try {
      return await probeTwitterAnonymous(url);
    } catch (e) {
      logError('probe', e, url);
    }
  }

  // A bare profile link (instagram.com/<username>) while logged in means
  // "grab their active stories" — the reels_media prober takes the whole
  // reel. Anonymous profile links keep the old yt-dlp behavior.
  const profileStories = instagramProfileToStoriesUrl(url);
  if (profileStories && (await hasCookiesForDomain('instagram.com'))) {
    try {
      return await probeInstagramStory(profileStories);
    } catch (e) {
      logError('probe', e, url);
    }
  }

  // Instagram stories. yt-dlp's story extractor silently drops photo
  // items (it only builds formats from video_versions), so a [photo,
  // video] story would probe as just the video. The cookied JS prober
  // hits the same reels_media API and returns EVERY item as a direct
  // CDN entry. On any prober failure fall through to cookied yt-dlp,
  // which still handles the video items.
  if (isInstagramStoryUrl(url)) {
    if (await hasCookiesForDomain('instagram.com')) {
      try {
        return await probeInstagramStory(url);
      } catch (e) {
        // Fall through to yt-dlp — but leave a trace, or a prober that
        // rots (API shape change) silently downgrades stories to
        // videos-only forever with nobody the wiser.
        logError('probe', e, url);
        console.warn(
          '[instagramStories] prober failed, falling back to yt-dlp:',
          e instanceof Error ? e.message : String(e)
        );
      }
    } else {
      // Without login, both the JS prober and yt-dlp are hard-walled by
      // Instagram — surface the actionable fix instead of yt-dlp's
      // cryptic "Restricted Video: You must be 18 years old ..." tail.
      throw new Error(
        'Instagram stories require login — connect Instagram under Credits → Platform logins, then try again.'
      );
    }
  }

  // Instagram posts (/p/, /reel/, /tv/).
  //  - Logged in: hit the cookied media-info API. Cookied yt-dlp drops
  //    every IMAGE item (its formats come only from video_versions), so a
  //    photo carousel would probe to nothing — the API returns all
  //    children with photo AND video CDN URLs.
  //  - Anonymous: the public embed endpoint (first carousel item only —
  //    the rest are login-gated). Gating on the instagram.com domain
  //    specifically, not the shared cookies file's existence, so a user
  //    logged into an unrelated platform keeps the anonymous path.
  // Both fall through to yt-dlp on failure.
  if (isInstagramPostUrl(url)) {
    if (await hasCookiesForDomain('instagram.com')) {
      try {
        return await probeInstagramPost(url);
      } catch (e) {
        logError('probe', e, url);
        console.warn(
          '[instagramStories] post prober failed, falling back to yt-dlp:',
          e instanceof Error ? e.message : String(e)
        );
      }
    } else {
      try {
        return await probeInstagramAnonymous(url);
      } catch {
        // Fall through to yt-dlp.
      }
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
    // Share links carry tracking params (?utm_source=…, ?igsh=…, ?_t=…)
    // that yt-dlp strips from each entry's webpage_url. Comparing raw
    // strings would make every carousel child look "self-contained"
    // (own URL ≠ pasted URL), so each would re-download the parent post
    // instead of its own --playlist-items slice. Strip ONLY tracking
    // params — the whole query must survive because for YouTube it IS
    // the identity (watch?v=A vs watch?v=B share a path; nuking the
    // query would demote every playlist entry to a carousel child).
    const TRACKING = /^(utm_.*|igsh|si|_t|_r|fbclid|gclid|mc_cid|mc_eid|feature|ig_mid)$/i;
    const canonical = (u: string) => {
      const [path, query = ''] = u.split('#')[0].split('?');
      const kept = query
        .split('&')
        .filter((kv) => kv.length > 0 && !TRACKING.test(kv.split('=')[0]))
        .join('&');
      return `${path.replace(/\/+$/, '')}${kept ? `?${kept}` : ''}`;
    };
    (raw.entries as Array<Record<string, unknown>>).forEach((e, i) => {
      // An entry that carries its own distinct URL (YouTube playlist
      // videos) downloads directly. Carousel/story children (Instagram,
      // TikTok, Reddit) share the parent post URL — their only usable
      // identity is the playlist position, which the download step turns
      // into --playlist-items so each child fetches its own media.
      const ownUrl =
        typeof e.webpage_url === 'string' && e.webpage_url.length > 0
          ? e.webpage_url
          : typeof e.url === 'string' && e.url.length > 0
          ? e.url
          : undefined;
      const selfContained =
        ownUrl !== undefined && canonical(ownUrl) !== canonical(parentUrl);
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
    // NEVER use yt-dlp's top-level `url` here: for sites whose best format
    // is a single pre-merged file (TikTok, Twitter/X, cookied Instagram,
    // SoundCloud) it's the selected format's signed, expiring CDN media
    // URL. Re-running yt-dlp against that hits the generic extractor
    // (unknown codecs → "Requested format is not available") or a 403
    // once the signature lapses. webpage_url is the canonical page.
    const pageUrl =
      typeof single.webpage_url === 'string' && single.webpage_url.length > 0
        ? single.webpage_url
        : typeof single.original_url === 'string' && single.original_url.length > 0
        ? single.original_url
        : url;
    entries.push({
      id: String(single.id ?? Date.now()),
      title: String(single.title ?? 'Untitled'),
      thumbnail: typeof single.thumbnail === 'string' ? single.thumbnail : undefined,
      duration: typeof single.duration === 'number' ? single.duration : undefined,
      mediaType: detectMediaType(single),
      webpageUrl: pageUrl,
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
  /** id identifies the exact failed entry — titles are NOT unique
   *  (carousel children share one), so retry flows must match on id. */
  errors: Array<{ id: string; title: string; message: string }>;
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
  // The trailing bare `bv*` terms fire only when NO audio stream exists
  // anywhere (muted Instagram stories, silent tweets) — every earlier
  // term already claimed anything with audio, and `bv*` still requires a
  // video codec, so the audio-only-file regression can't come back. A
  // soundless clip downloads as-is instead of "Requested format is not
  // available".
  if (!quality || quality === 'best') {
    return 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/bv*[ext=mp4]/bv*';
  }
  // Capped chain: prefer the cap with audio, then ANY size with audio
  // (`bv*+ba` — a too-strict cap must not silently produce a soundless
  // file when the source has audio), then audio-less as the true last
  // resort for sources with no audio stream at all.
  const h = quality;
  return `best[height<=${h}][ext=mp4][acodec!=none][vcodec!=none]/best[height<=${h}][acodec!=none][vcodec!=none]/bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/bv*+ba/best[acodec!=none][vcodec!=none]/bv*[height<=${h}]/bv*`;
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

  // Direct-URL fast path. The Instagram/Twitter probers resolve each
  // item to a CDN URL — we can fetch those over plain HTTPS without
  // involving yt-dlp at all. Saves a Python + yt-dlp round trip and
  // works for media yt-dlp can't see (photos especially). EXCEPT when
  // the user asked for Audio from a video item: a raw CDN fetch can't
  // extract audio, so fall through to yt-dlp (webpageUrl still resolves
  // the item) and let `-x` do its job.
  if (opts.entry.directUrl && !(opts.audioOnly && opts.entry.mediaType === 'video')) {
    // Honor the quality cap when the prober exposed multiple encodes:
    // largest variant that fits under the cap, or the smallest one when
    // nothing fits (closest to what the user asked for).
    let directUrl = opts.entry.directUrl;
    const variants = opts.entry.variants;
    if (
      opts.entry.mediaType === 'video' &&
      variants &&
      variants.length > 0 &&
      opts.quality &&
      opts.quality !== 'best'
    ) {
      const cap = parseInt(opts.quality, 10);
      const area = (v: { width?: number; height?: number }) => (v.width ?? 0) * (v.height ?? 0);
      const fitting = variants.filter((v) => (v.height ?? 0) > 0 && (v.height ?? 0) <= cap);
      const pool = fitting.length > 0 ? fitting : variants.slice();
      const pick = pool.reduce((a, b) =>
        fitting.length > 0 ? (area(a) >= area(b) ? a : b) : area(a) <= area(b) ? a : b
      );
      if (pick.url) directUrl = pick.url;
    }
    return downloadDirect({
      sessionId: opts.sessionId,
      entry: opts.entry,
      directUrl,
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

  inflightCancels.set(opts.sessionId, () => Downloader.cancel(opts.sessionId));

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
      // Quality is now folded into formatString above — keep it for the
      // native side's audio-quality option but otherwise unused.
      quality: audioOnly ? opts.quality ?? undefined : undefined,
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
    inflightCancels.delete(opts.sessionId);
  }
}

/** How many direct-CDN transfers may run at once. Plain HTTPS fetches are
 *  cheap; 3 keeps a 10-photo carousel fast without saturating the radio.
 *  yt-dlp items stay strictly sequential — each spawns a python process. */
const DIRECT_CONCURRENCY = 3;

const PENDING_BATCH_KEY = '@convertx/pending-batch.v1';

export type PendingBatch = {
  sourceUrl: string;
  at: number;
  audioOnly: boolean;
  format: string | null;
  quality: string | null;
  items: Array<{ id: string; title: string }>;
  remainingIds: string[];
};

/** The batch descriptor a killed app left behind, if any. */
export async function getPendingBatch(): Promise<PendingBatch | null> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_BATCH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingBatch;
    // Stale descriptors (probe data long expired) aren't worth resuming.
    if (Date.now() - parsed.at > 24 * 60 * 60 * 1000) {
      await AsyncStorage.removeItem(PENDING_BATCH_KEY).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingBatch(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_BATCH_KEY).catch(() => {});
}

/**
 * Run multiple downloads. Direct-CDN items run a few at a time; yt-dlp
 * items run sequentially alongside them. Reports overall progress
 * (0..100 across the whole batch) so the UI can show a single bar.
 * Errors per item are collected and returned — one failure doesn't
 * abort the rest of the batch. An expired direct URL (4xx) triggers ONE
 * re-probe of sourceUrl for the whole batch; fresh URLs are matched back
 * by entry id and the item retried.
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
  /** The URL the entries were probed from — enables the 4xx auto-refresh
   *  and the killed-app resume descriptor. */
  sourceUrl?: string;
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
  let cancelled = false;
  let lastPublicPath: string | undefined;
  const errors: BatchDownloadResult['errors'] = [];
  const perItemPct = new Array<number>(total).fill(0);
  const remaining = new Set(opts.entries.map((e) => e.id));

  const reportOverall = (idx: number) => {
    const sum = perItemPct.reduce((a, b) => a + b, 0);
    opts.onProgress(Math.round(sum / total), idx);
  };

  // Crash/kill insurance: persist what's left so the next launch can offer
  // to resume. Fire-and-forget — the download must not wait on storage.
  const persistRemaining = () => {
    if (!opts.sourceUrl) return;
    const snapshot: PendingBatch = {
      sourceUrl: opts.sourceUrl,
      at: Date.now(),
      audioOnly: opts.audioOnly,
      format: opts.format,
      quality: opts.quality,
      items: opts.entries.map((e) => ({ id: e.id, title: e.title })),
      remainingIds: [...remaining],
    };
    AsyncStorage.setItem(PENDING_BATCH_KEY, JSON.stringify(snapshot)).catch(() => {});
  };

  // One re-probe for the whole batch, shared by every worker that hits an
  // expired URL. Memoized as a promise so concurrent 4xx failures don't
  // stampede the prober.
  let refreshPromise: Promise<Map<string, DownloadEntry>> | null = null;
  const refreshEntries = (): Promise<Map<string, DownloadEntry>> => {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const probed = await probeUrl(opts.sourceUrl as string, {
          cookies,
          spotifyClientId: opts.spotifyClientId,
          spotifyClientSecret: opts.spotifyClientSecret,
        });
        return new Map(probed.entries.map((e) => [e.id, e]));
      })();
    }
    return refreshPromise;
  };

  const runOne = async (i: number): Promise<void> => {
    let entry = opts.entries[i];
    opts.onItemStart?.(i, entry);
    let refreshed = false;
    for (;;) {
      // A Cancel tap can land while this item is between transfers (e.g.
      // awaiting the 4xx re-probe) — at that moment it has no registered
      // cancel closure, so the flag check is the ONLY thing standing
      // between the user's Cancel and a ghost download completing into
      // the gallery.
      if (cancelled || cancelRequested) {
        cancelled = true;
        return;
      }
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
            perItemPct[i] = pct;
            reportOverall(i);
          },
        });
        if (r.cancelled) {
          cancelled = true;
          return;
        }
        perItemPct[i] = 100;
        reportOverall(i);
        done += 1;
        remaining.delete(entry.id);
        persistRemaining();
        if (r.publicPath) lastPublicPath = r.publicPath;
        opts.onItemDone?.(entry, r);
        return;
      } catch (e) {
        // Expired signed CDN URL → re-probe the source once (batch-wide)
        // and retry this item with its fresh URL instead of failing it.
        const expired =
          e instanceof HttpStatusError && [401, 403, 404, 410, 429].includes(e.status);
        if (expired && !refreshed && entry.directUrl && opts.sourceUrl) {
          refreshed = true;
          try {
            const fresh = (await refreshEntries()).get(entry.id);
            if (fresh?.directUrl) {
              entry = { ...entry, directUrl: fresh.directUrl, variants: fresh.variants };
              // The failed attempt's error-body transfer may have pushed
              // this slot toward 100 — reset so the bar doesn't lie, then
              // let the loop's cancel check gate the actual retry.
              perItemPct[i] = 0;
              continue;
            }
          } catch (probeErr) {
            logError('download', probeErr, `refresh of ${opts.sourceUrl}`);
          }
        }
        failed += 1;
        // Count the failed slot as "complete" for the bar — the old
        // sequential formula did implicitly, and without this a batch
        // with any failure can never reach 100%.
        perItemPct[i] = 100;
        reportOverall(i);
        remaining.delete(entry.id);
        persistRemaining();
        logError('download', e, entry.title);
        errors.push({
          id: entry.id,
          title: entry.title,
          message: e instanceof Error ? e.message : String(e),
        });
        // Keep going — a single bad item shouldn't kill a 30-track playlist.
        return;
      }
    }
  };

  // A previous batch that was cancelled mid-item leaves cancelRequested set
  // (the cancelled early-return path doesn't clear it). Reset here so a
  // fresh batch isn't aborted on iteration 0. See cancelBatch().
  cancelRequested = false;

  batchActive = true;
  // Screen-off must not freeze the JS loop feeding the queue. Best-effort:
  // keep-awake is cosmetic-level API, never let it break a download.
  activateKeepAwakeAsync('convertx-batch').catch(() => {});
  persistRemaining();
  try {
    const directIdx: number[] = [];
    const ytdlpIdx: number[] = [];
    opts.entries.forEach((e, i) => {
      const direct = !!e.directUrl && !(opts.audioOnly && e.mediaType === 'video');
      (direct ? directIdx : ytdlpIdx).push(i);
    });

    // Direct pool: DIRECT_CONCURRENCY workers pulling from a shared queue.
    // yt-dlp lane: strictly sequential (python process per item). Both
    // lanes run at the same time and stop pulling once cancelled.
    let cursor = 0;
    const directWorker = async () => {
      while (!cancelled && !cancelRequested && cursor < directIdx.length) {
        const idx = directIdx[cursor++];
        await runOne(idx);
      }
    };
    const ytdlpLane = async () => {
      for (const idx of ytdlpIdx) {
        if (cancelled || cancelRequested) return;
        await runOne(idx);
      }
    };
    await Promise.all([
      ...Array.from({ length: Math.min(DIRECT_CONCURRENCY, directIdx.length) }, directWorker),
      ytdlpLane(),
    ]);

    if (cancelled || cancelRequested) {
      cancelRequested = false;
      // A deliberate cancel is not an interruption — don't offer to
      // resume it on next launch.
      await clearPendingBatch();
      return { done, failed, cancelled: true, lastPublicPath, errors };
    }
    await clearPendingBatch();
    return { done, failed, cancelled: false, lastPublicPath, errors };
  } finally {
    batchActive = false;
    deactivateKeepAwake('convertx-batch').catch(() => {});
  }
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
  let cancelled = false;
  inflightCancels.set(opts.sessionId, () => {
    cancelled = true;
    dl?.cancelAsync().catch(() => {});
  });

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
    if (cancelled) {
      // cancelAsync resolves the promise without a uri — report a real
      // cancellation so the batch stops instead of logging a failure.
      await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
      return { cancelled: true };
    }
    if (!result?.uri) {
      throw new Error('Direct download produced no file.');
    }
    // downloadAsync resolves (not rejects) on HTTP errors and writes the
    // error body to the target file — without this check a 403 from an
    // expired signed CDN URL would be saved to the gallery as "media"
    // and reported as a success.
    if (typeof result.status === 'number' && (result.status < 200 || result.status >= 300)) {
      throw new HttpStatusError(
        result.status,
        `Media URL expired or blocked (HTTP ${result.status}) — tap Find again to refresh it.`
      );
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
    inflightCancels.delete(opts.sessionId);
  }
}
