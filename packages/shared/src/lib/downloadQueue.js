/**
 * Shared download queue: probe router + two-lane batch runner.
 *
 * Each download session goes through:
 *   1. probeUrl(url) — Twitter/Instagram JS probers or yt-dlp (--dump-json)
 *   2. downloadBatch(entries, …) — direct-CDN lane (3 concurrent HTTPS
 *      fetches) + strictly sequential yt-dlp lane, run side by side.
 *
 * Platform access is exclusively through the adapter (getPlatform()), and
 * every method is feature-detected — on web the probers/downloads throw
 * exactly like today's "URL downloads need the desktop app" path.
 *
 * NOTE: Spotify URLs never reach this module — the caller short-circuits
 * them to the spotdl path BEFORE the router.
 *
 * DownloadEntry shape (produced by the router + probers, consumed by the
 * batch runner and the UI):
 *   {
 *     id,             // STABLE: IG media pk, Twitter `${statusId}-${i+1}`,
 *                     // else `${canonical(sourceUrl)}#${index}`
 *     title,          // unique per item within a probe (filenames derive from it)
 *     url,            // webpage_url for the yt-dlp lane (NEVER yt-dlp's signed `url`)
 *     sourceUrl,      // the pasted URL this entry came from
 *     playlistIndex,  // 1-based; ONLY for playlist/carousel children (else null)
 *     mediaType,      // 'video' | 'audio' | 'image'
 *     thumbnail,      // string | null
 *     directUrl,      // non-null => eligible for the direct-CDN lane
 *     variants,       // [{url, width, height}] | null — quality-cap selection
 *     duration,       // number | null
 *     uploader,       // string | null
 *     partialCarousel // from the anonymous IG embed prober only
 *   }
 */

import { getPlatform } from "../platform.js";
import { hasCookiesForDomain, resolveCookiesPath } from "./cookies.js";
import { logError } from "./errorLog.js";
import { isInstagramPostUrl, probeInstagramAnonymous } from "./instagramScraper.js";
import {
  instagramProfileToStoriesUrl,
  isInstagramStoryUrl,
  probeInstagramPost,
  probeInstagramStory,
} from "./instagramStories.js";
import { isTwitterStatusUrl, probeTwitterAnonymous } from "./twitterScraper.js";
import { loadJson, saveJson, removeKey } from "./storage.js";

// ---------------------------------------------------------------------------
// yt-dlp freshness / self-update
// ---------------------------------------------------------------------------

// Keyed by yt-dlp release cadence (year.month) rather than a one-shot
// boolean: extractors rot within weeks when sites change their APIs, so
// re-check for a fresh yt-dlp once per calendar month instead of exactly
// once in the app's lifetime.
const YTDLP_FRESHNESS_KEY = "convertx.ytdlpFreshness";

function currentFreshnessStamp() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

let ytdlpUpdateInflight = null;

/**
 * Update the yt-dlp engine (inflight-deduped — a Credits-card click while
 * the boot check runs returns the same promise). Resolves
 * { ok, status?: 'DONE'|'ALREADY_UP_TO_DATE', version?, error? }.
 */
export function updateYtDlpDeduped() {
  if (ytdlpUpdateInflight) return ytdlpUpdateInflight;
  const run = (async () => {
    try {
      const platform = getPlatform();
      if (typeof platform.updateYtdlp !== "function") {
        return { ok: false, error: "Engine updates are not available on this platform." };
      }
      const result = await platform.updateYtdlp();
      return { ok: true, status: result?.status, version: result?.version ?? null };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })();
  ytdlpUpdateInflight = run;
  return run.finally(() => {
    ytdlpUpdateInflight = null;
  });
}

/**
 * Run the calendar-month freshness check: update yt-dlp at most once per
 * month, silently. Call on desktop boot; a no-op when the adapter can't
 * update (web) or the stamp is current.
 */
export async function runMonthlyYtdlpFreshnessCheck() {
  try {
    let platform;
    try {
      platform = getPlatform();
    } catch {
      return;
    }
    if (typeof platform.updateYtdlp !== "function") return;
    const stamp = loadJson(YTDLP_FRESHNESS_KEY, null);
    if (stamp === currentFreshnessStamp()) return;
    const result = await updateYtDlpDeduped();
    if (result.ok) {
      saveJson(YTDLP_FRESHNESS_KEY, currentFreshnessStamp());
    }
  } catch {
    // Silent — will retry on next launch.
  }
}

// ---------------------------------------------------------------------------
// Probe router
// ---------------------------------------------------------------------------

const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "heic", "heif", "bmp", "tiff", "avif", "gif"];
const AUDIO_CONTAINERS = ["mp3", "m4a", "aac", "wav", "flac", "opus", "ogg", "vorbis", "wma"];

/**
 * Classify a raw yt-dlp info entry as video / audio / image. yt-dlp
 * reports `vcodec`/`acodec` = "none" (and no duration) for still images;
 * audio-only sources (SoundCloud, Bandcamp) have an acodec but no vcodec.
 * Used as the fallback when the Rust probe didn't pre-classify.
 */
export function detectMediaType(e) {
  const ext = String(e?.ext ?? "").toLowerCase();
  const vcodec = String(e?.vcodec ?? "").toLowerCase();
  const acodec = String(e?.acodec ?? "").toLowerCase();
  const hasVideo = vcodec !== "" && vcodec !== "none";
  const hasAudio = acodec !== "" && acodec !== "none";
  const hasDuration = typeof e?.duration === "number" && e.duration > 0;

  if (hasVideo) return "video";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (hasAudio || hasDuration) return "audio";
  // No video codec, not a known image ext, no audio track, no timeline —
  // this is how yt-dlp presents a still image (vcodec/acodec both "none").
  if (vcodec === "none" && acodec === "none") return "image";
  // Genuinely unknown → treat as video.
  return "video";
}

// Share links carry tracking params (?utm_source=…, ?igsh=…, ?_t=…)
// that yt-dlp strips from each entry's webpage_url. Comparing raw
// strings would make every carousel child look "self-contained"
// (own URL ≠ pasted URL), so each would re-download the parent post
// instead of its own --playlist-items slice. Strip ONLY tracking
// params — the whole query must survive because for YouTube it IS
// the identity (watch?v=A vs watch?v=B share a path; nuking the
// query would demote every playlist entry to a carousel child).
const TRACKING = /^(utm_.*|igsh|si|_t|_r|fbclid|gclid|mc_cid|mc_eid|feature|ig_mid)$/i;

export function canonical(u) {
  const [path, query = ""] = String(u).split("#")[0].split("?");
  const kept = query
    .split("&")
    .filter((kv) => kv.length > 0 && !TRACKING.test(kv.split("=")[0]))
    .join("&");
  return `${path.replace(/\/+$/, "")}${kept ? `?${kept}` : ""}`;
}

/** Direct-CDN failure that carries the HTTP status — the batch layer
 *  distinguishes an expired signed URL (re-probe and retry) from a
 *  genuinely broken one (fail the item). */
export class HttpStatusError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

const VALID_KINDS = new Set(["video", "audio", "image"]);

/** Shape the Rust probe result (kind: 'single'|'multi', entries with
 *  index/title/thumbnail/duration/kind/url/webpage_url) into DownloadEntry
 *  objects with the webpage_url-over-url discipline. */
function entriesFromYtdlpProbe(raw, sourceUrl) {
  const rawEntries = Array.isArray(raw?.entries) ? raw.entries : [];
  const isMulti = raw?.kind === "multi" && rawEntries.length > 1;
  const uploader = typeof raw?.uploader === "string" ? raw.uploader : null;
  const entries = [];

  if (isMulti) {
    const parentUrl = sourceUrl;
    rawEntries.forEach((e, i) => {
      const idx = typeof e.index === "number" ? e.index : i + 1;
      // An entry that carries its own distinct URL (YouTube playlist
      // videos) downloads directly with --no-playlist. Carousel/story
      // children (Instagram, TikTok, Reddit) share the parent post URL —
      // their only usable identity is the playlist position, which the
      // download step turns into --playlist-items so each child fetches
      // its own media instead of the whole carousel resolving to one
      // file N times.
      const pageUrl = e.webpage_url ?? e.webpageUrl;
      const ownUrl =
        typeof pageUrl === "string" && pageUrl.length > 0
          ? pageUrl
          : typeof e.url === "string" && e.url.length > 0
            ? e.url
            : null;
      const selfContained = ownUrl !== null && canonical(ownUrl) !== canonical(parentUrl);
      entries.push({
        id: `${canonical(sourceUrl)}#${idx}`,
        title: typeof e.title === "string" && e.title.length > 0 ? e.title : "Untitled",
        url: selfContained ? ownUrl : parentUrl,
        sourceUrl,
        playlistIndex: selfContained ? null : idx,
        mediaType: VALID_KINDS.has(e.kind) ? e.kind : detectMediaType(e),
        thumbnail: typeof e.thumbnail === "string" ? e.thumbnail : null,
        directUrl: null,
        variants: null,
        duration: typeof e.duration === "number" ? e.duration : null,
        uploader,
        partialCarousel: false,
      });
    });
  } else if (rawEntries.length > 0) {
    const e = rawEntries[0];
    // NEVER use yt-dlp's raw `url` for a single entry: for sites whose
    // best format is a single pre-merged file (TikTok, Twitter/X, cookied
    // Instagram, SoundCloud) it's the selected format's signed, expiring
    // CDN media URL. Re-running yt-dlp against that hits the generic
    // extractor or a 403 once the signature lapses. webpage_url is the
    // canonical page; the pasted URL is the fallback.
    const rawPageUrl = e.webpage_url ?? e.webpageUrl;
    const pageUrl =
      typeof rawPageUrl === "string" && rawPageUrl.length > 0 ? rawPageUrl : sourceUrl;
    entries.push({
      id: `${canonical(sourceUrl)}#1`,
      title: typeof e.title === "string" && e.title.length > 0 ? e.title : "Untitled",
      url: pageUrl,
      sourceUrl,
      playlistIndex: null,
      mediaType: VALID_KINDS.has(e.kind) ? e.kind : detectMediaType(e),
      thumbnail: typeof e.thumbnail === "string" ? e.thumbnail : null,
      directUrl: null,
      variants: null,
      duration: typeof e.duration === "number" ? e.duration : null,
      uploader,
      partialCarousel: false,
    });
  }

  return entries;
}

/** Normalize a prober ProbeResult ({site, isPlaylist, entries}) into the
 *  router's return shape, deriving the preview fields the UI reads. */
function normalizeProberResult(res) {
  const first = res.entries[0];
  return {
    site: res.site ?? null,
    isPlaylist: !!res.isPlaylist,
    kind: res.isPlaylist ? "multi" : "single",
    title: first?.title ?? "Untitled",
    uploader: first?.uploader ?? null,
    thumbnail: first?.thumbnail ?? null,
    entries: res.entries,
  };
}

/**
 * Probe a URL. Router order (verbatim Android):
 *   1. Twitter/X status → anonymous syndication prober (any throw → log +
 *      yt-dlp fallthrough)
 *   2. bare IG profile + IG cookies → rewrite to /stories/<user>/ prober
 *   3. IG story → cookied prober when instagram.com cookies exist, else a
 *      HARD throw with the actionable login hint
 *   4. IG post → cookied media-info prober with cookies, else anonymous
 *      embed prober; both fall through to yt-dlp
 *   5. everything else → yt-dlp (platform.probeUrl)
 *
 * The cookie gate is per-DOMAIN (instagram.com), not file existence, and
 * cookies are resolved from the on-disk file, not caller state.
 *
 * NOT handled here: Spotify (caller short-circuits before the router).
 */
export async function probeUrl(url, opts = {}) {
  const platform = getPlatform();
  const hasHttp = typeof platform.httpRequest === "function";

  // On-disk cookies.txt is the source of truth for "logged in" — fall
  // back to it when the caller's cookiesPath is momentarily empty
  // (hydration race), so a logged-in user's first private-post download
  // doesn't fail with "login required".
  const cookiesPath = opts.cookiesPath || (await resolveCookiesPath());

  // Twitter/X status URLs: yt-dlp errors on pure-photo tweets ("No video
  // could be found in this tweet") — the anonymous syndication prober
  // handles photos, multi-photo posts, and videos alike. Failures
  // (protected/deleted/NSFW-gated tweets) fall through to yt-dlp, which
  // can use the user's cookies.
  if (hasHttp && isTwitterStatusUrl(url)) {
    try {
      return normalizeProberResult(await probeTwitterAnonymous(url));
    } catch (e) {
      logError("probe", e, url);
    }
  }

  // A bare profile link (instagram.com/<username>) while logged in means
  // "grab their active stories" — the reels_media prober takes the whole
  // reel. Anonymous profile links keep the old yt-dlp behavior.
  const profileStories = hasHttp ? instagramProfileToStoriesUrl(url) : null;
  if (profileStories && (await hasCookiesForDomain("instagram.com"))) {
    try {
      return normalizeProberResult(await probeInstagramStory(profileStories));
    } catch (e) {
      logError("probe", e, url);
    }
  }

  // Instagram stories. yt-dlp's story extractor silently drops photo
  // items (it only builds formats from video_versions), so a [photo,
  // video] story would probe as just the video. The cookied JS prober
  // hits the same reels_media API and returns EVERY item as a direct
  // CDN entry. On any prober failure fall through to cookied yt-dlp,
  // which still handles the video items.
  if (hasHttp && isInstagramStoryUrl(url)) {
    if (await hasCookiesForDomain("instagram.com")) {
      try {
        return normalizeProberResult(await probeInstagramStory(url));
      } catch (e) {
        // Fall through to yt-dlp — but leave a trace, or a prober that
        // rots (API shape change) silently downgrades stories to
        // videos-only forever with nobody the wiser.
        logError("probe", e, url);
        console.warn(
          "[instagramStories] prober failed, falling back to yt-dlp:",
          e instanceof Error ? e.message : String(e)
        );
      }
    } else {
      // Without login, both the JS prober and yt-dlp are hard-walled by
      // Instagram — surface the actionable fix instead of yt-dlp's
      // cryptic "Restricted Video: You must be 18 years old ..." tail.
      throw new Error(
        "Instagram stories require login — connect Instagram under Credits → Platform logins, then try again."
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
  if (hasHttp && isInstagramPostUrl(url)) {
    if (await hasCookiesForDomain("instagram.com")) {
      try {
        return normalizeProberResult(await probeInstagramPost(url));
      } catch (e) {
        logError("probe", e, url);
        console.warn(
          "[instagramStories] post prober failed, falling back to yt-dlp:",
          e instanceof Error ? e.message : String(e)
        );
      }
    } else {
      try {
        return normalizeProberResult(await probeInstagramAnonymous(url));
      } catch {
        // Fall through to yt-dlp.
      }
    }
  }

  // Everything else → yt-dlp. The Rust command rejects with a friendly
  // message (incl. the 3-line stderr tail) on failure — let it propagate.
  if (typeof platform.probeUrl !== "function") {
    throw new Error("URL downloads require the desktop app.");
  }
  const raw = await platform.probeUrl(url, { cookiesPath: cookiesPath || null });
  const entries = entriesFromYtdlpProbe(raw, url);
  if (entries.length === 0) {
    throw new Error("yt-dlp returned no playable items for this URL.");
  }
  return {
    site: null,
    isPlaylist: entries.length > 1,
    kind: entries.length > 1 ? "multi" : "single",
    title: typeof raw?.title === "string" ? raw.title : (entries[0]?.title ?? "Untitled"),
    uploader: typeof raw?.uploader === "string" ? raw.uploader : null,
    thumbnail: typeof raw?.thumbnail === "string" ? raw.thumbnail : null,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Pending-batch persistence (kill-proof resume)
// ---------------------------------------------------------------------------

const PENDING_BATCH_KEY = "convertx.pendingBatch.v1";

/**
 * The batch descriptor a killed app left behind, if any:
 * { sourceUrl, at, audioOnly, format, quality, items: [{id,title}], remainingIds }.
 * Stale descriptors (>24h — probe data long expired) are dropped.
 */
export function getPendingBatch() {
  const parsed = loadJson(PENDING_BATCH_KEY, null);
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.at !== "number" || Date.now() - parsed.at > 24 * 60 * 60 * 1000) {
    removeKey(PENDING_BATCH_KEY);
    return null;
  }
  return parsed;
}

export function clearPendingBatch() {
  removeKey(PENDING_BATCH_KEY);
}

// ---------------------------------------------------------------------------
// Batch runner
// ---------------------------------------------------------------------------

/** How many direct-CDN transfers may run at once. Plain HTTPS fetches are
 *  cheap; 3 keeps a 10-photo carousel fast without saturating the link.
 *  yt-dlp items stay strictly sequential — each spawns a python process. */
const DIRECT_CONCURRENCY = 3;

// True for the whole life of a downloadBatch call, plus the batch-level
// cancel flag. A Cancel click can land while an item is between transfers
// (e.g. awaiting the 4xx re-probe) — at that moment nothing native is
// running for it, so the flag check is the ONLY thing standing between
// the user's Cancel and a ghost download completing into the folder.
let batchActive = false;
let cancelRequested = false;

export function isDownloading() {
  return batchActive;
}

/** Cancel the active batch: flag the loops AND kill every in-flight
 *  native transfer (yt-dlp process or direct stream). Never surfaces as
 *  an error — the typed { status: 'cancelled' } results unwind cleanly. */
export function cancelActiveBatch() {
  cancelRequested = true;
  try {
    const platform = getPlatform();
    if (typeof platform.cancelDownload === "function") {
      // No fileId = cancel ALL active downloads (both lanes).
      const r = platform.cancelDownload();
      if (r && typeof r.catch === "function") r.catch(() => {});
    }
  } catch {
    // Best-effort — the flag alone still stops the batch between items.
  }
}

function setKeepAwakeSafe(active) {
  // Screen-off / sleep must not freeze a long batch. Best-effort:
  // keep-awake is cosmetic-level API, never let it break a download.
  try {
    const platform = getPlatform();
    if (typeof platform.setKeepAwake === "function") {
      const r = platform.setKeepAwake(active);
      if (r && typeof r.catch === "function") r.catch(() => {});
    }
  } catch {
    // ignore
  }
}

/** Filename-safe stem for the direct lane (matches the Android
 *  sanitization so filenames stay predictable). */
function sanitizeName(s) {
  return String(s).replace(/[^A-Za-z0-9_\-]/g, "_");
}

/** Direct lane iff the entry has a CDN URL and the user didn't ask for
 *  audio extraction from a video (a raw CDN fetch can't extract audio —
 *  those fall to yt-dlp, which resolves the page URL and runs -x). */
function isDirectLane(entry, audioOnly) {
  return !!entry.directUrl && !(audioOnly && entry.mediaType === "video");
}

/**
 * Run multiple downloads. Direct-CDN items run a few at a time; yt-dlp
 * items run sequentially alongside them. Reports overall progress as the
 * mean of per-item percents so the UI can show a single bar. Errors per
 * item are collected and returned — one failure doesn't abort the rest of
 * the batch. An expired direct URL (4xx) triggers ONE re-probe of
 * sourceUrl for the whole batch; fresh URLs are matched back by entry id
 * and the item retried once.
 *
 * onProgress receives { overallPct, completed, total, currentTitle };
 * onItemDone(entry, { outputPath }) fires after each success (history).
 *
 * Returns { results: [{ id, title, outputPath }], errors: [{ id, title,
 * message }], cancelled }.
 */
export async function downloadBatch(opts) {
  const {
    entries,
    audioOnly = false,
    format = null,
    quality = null,
    outputDir,
    sourceUrl,
    onProgress,
    onItemDone,
  } = opts;

  const platform = getPlatform();
  const total = Array.isArray(entries) ? entries.length : 0;
  const results = [];
  const errors = [];
  if (total === 0) {
    return { results, errors, cancelled: false };
  }

  // Same source-of-truth resolution as probeUrl: use on-disk cookies so a
  // logged-in download never fails for lack of a cookie path.
  const cookiesPath = (await resolveCookiesPath()) || null;

  let cancelled = false;
  let completed = 0;
  let currentTitle = entries[0]?.title ?? "";
  const perItemPct = new Array(total).fill(0);
  const remaining = new Set(entries.map((e) => e.id));
  const batchId = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dedupeNames = total > 1;

  const reportOverall = () => {
    if (typeof onProgress !== "function") return;
    const sum = perItemPct.reduce((a, b) => a + b, 0);
    try {
      onProgress({
        overallPct: Math.round(sum / total),
        completed,
        total,
        currentTitle,
      });
    } catch {
      // A broken progress callback must not kill the batch.
    }
  };

  // Crash/kill insurance: persist what's left so the next launch can offer
  // to resume. Best-effort — the download must not wait on storage.
  const persistRemaining = () => {
    if (!sourceUrl) return;
    saveJson(PENDING_BATCH_KEY, {
      sourceUrl,
      at: Date.now(),
      audioOnly,
      format,
      quality,
      items: entries.map((e) => ({ id: e.id, title: e.title })),
      remainingIds: [...remaining],
    });
  };

  // One re-probe for the whole batch, shared by every worker that hits an
  // expired URL. Memoized as a promise so concurrent 4xx failures don't
  // stampede the prober.
  let refreshPromise = null;
  const refreshEntries = () => {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const probed = await probeUrl(sourceUrl, { cookiesPath });
        return new Map(probed.entries.map((e) => [e.id, e]));
      })();
    }
    return refreshPromise;
  };

  // Interleaved progress events carry file_id — map them back to slots.
  const fileIdToSlot = new Map();
  let unsubProgress = null;
  if (typeof platform.onDownloadProgress === "function") {
    unsubProgress = platform.onDownloadProgress((evt) => {
      if (!evt) return;
      const slot = fileIdToSlot.get(evt.file_id);
      if (slot === undefined) return;
      const pct = typeof evt.progress === "number" ? evt.progress : -1;
      // -1 = unknown length / unparsable line — don't let those knock a
      // progressing bar back to the left edge.
      if (pct >= 0) {
        perItemPct[slot] = Math.min(100, Math.round(pct));
        reportOverall();
      }
    });
  }

  /** Download one entry via the appropriate lane. Returns
   *  { cancelled: true } | { outputPath } and throws on real failure
   *  (HttpStatusError for direct-lane HTTP refusals). */
  const downloadOne = async (fileId, entry) => {
    if (isDirectLane(entry, audioOnly)) {
      if (typeof platform.downloadDirect !== "function") {
        throw new Error("Direct downloads are not available on this platform.");
      }
      // Honor the quality cap when the prober exposed multiple encodes:
      // largest variant that fits under the cap, or the smallest one when
      // nothing fits (closest to what the user asked for).
      let directUrl = entry.directUrl;
      const variants = entry.variants;
      if (
        entry.mediaType === "video" &&
        Array.isArray(variants) &&
        variants.length > 0 &&
        quality &&
        quality !== "best"
      ) {
        const cap = parseInt(quality, 10);
        const area = (v) => (v.width ?? 0) * (v.height ?? 0);
        const fitting = variants.filter((v) => (v.height ?? 0) > 0 && (v.height ?? 0) <= cap);
        const pool = fitting.length > 0 ? fitting : variants.slice();
        const pick = pool.reduce((a, b) =>
          fitting.length > 0 ? (area(a) >= area(b) ? a : b) : area(a) <= area(b) ? a : b
        );
        if (pick.url) directUrl = pick.url;
      }

      // Pick an extension by looking at the URL — CDN URLs end with
      // `.jpg` / `.mp4` / `.webp` before the query string.
      const urlPath = directUrl.split("?")[0];
      const extMatch = urlPath.match(/\.([a-zA-Z0-9]{2,5})$/);
      const ext = (extMatch ? extMatch[1] : "bin").toLowerCase();
      // Title only, matching the native direct path: the probers already
      // mint unique per-item titles (story pk / carousel index), so an id
      // suffix here just repeats what the title ends with. True collisions
      // are handled by the native collision suffix, not by renaming here.
      const stem = sanitizeName(entry.title);

      const r = await platform.downloadDirect({
        fileId,
        url: directUrl,
        destDir: outputDir,
        fileName: `${stem}.${ext}`,
        headers: {},
      });
      if (r?.status === "cancelled") return { cancelled: true };
      if (r?.status === "http_error") {
        // The native side never saves a non-2xx body as media — surface
        // the status so the batch layer can self-heal expired URLs.
        const st = r.httpStatus ?? r.http_status ?? 0;
        throw new HttpStatusError(
          st,
          `Media URL expired or blocked (HTTP ${st}) — hit Find again to refresh it.`
        );
      }
      return { outputPath: r?.outputPath ?? r?.output_path ?? null };
    }

    // yt-dlp lane.
    if (typeof platform.downloadFromUrl !== "function") {
      throw new Error("URL downloads require the desktop app.");
    }
    // Per-item strategy keys off the detected media type so the UI's
    // video/audio toggle can't produce an impossible request:
    //   - image  → 'image' (no video selector — it matches nothing on a
    //              photo and yt-dlp would error)
    //   - audio source (SoundCloud track) → always extract audio, even if
    //              the user left the toggle on "Video"
    //   - video  → honor the user's video/audio choice
    const kind = entry.mediaType ?? "video";
    const itemAudioOnly = kind === "image" ? false : kind === "audio" ? true : audioOnly;
    // When we FORCE audio on an audio-only source, the user's `format`
    // may still hold a video container (mp4/webm) — never request that as
    // the audio format. Fall back to mp3 unless it's a real audio container.
    const itemFormat =
      kind === "image"
        ? "image"
        : itemAudioOnly
          ? format && AUDIO_CONTAINERS.includes(String(format).toLowerCase())
            ? format
            : "mp3"
          : format || "mp4";

    const r = await platform.downloadFromUrl({
      fileId,
      url: entry.url,
      format: itemFormat,
      quality: quality || "best",
      outputDir,
      playlistItems: entry.playlistIndex != null ? String(entry.playlistIndex) : null,
      // Self-contained entries download their own page — --no-playlist
      // stops a video-in-playlist URL from re-expanding the whole list.
      noPlaylist: entry.playlistIndex == null,
      // Batches and carousel children get `%(title)s-%(id)s` so items that
      // share a title can't land on the same filename.
      dedupeNames: dedupeNames || entry.playlistIndex != null,
      cookiesPath,
    });
    if (r?.status === "cancelled" || r?.cancelled === true) return { cancelled: true };
    return { outputPath: r?.outputPath ?? r?.output_path ?? null, title: r?.title };
  };

  const runOne = async (i) => {
    let entry = entries[i];
    currentTitle = entry.title;
    reportOverall();
    let refreshed = false;
    for (;;) {
      // A Cancel click can land while this item is between transfers
      // (e.g. awaiting the 4xx re-probe) — the flag check gates it.
      if (cancelled || cancelRequested) {
        cancelled = true;
        return;
      }
      const fileId = `${batchId}-${i}`;
      fileIdToSlot.set(fileId, i);
      try {
        const r = await downloadOne(fileId, entry);
        if (r.cancelled) {
          cancelled = true;
          return;
        }
        perItemPct[i] = 100;
        completed += 1;
        reportOverall();
        remaining.delete(entry.id);
        persistRemaining();
        results.push({ id: entry.id, title: entry.title, outputPath: r.outputPath ?? null });
        if (typeof onItemDone === "function") {
          try {
            onItemDone(entry, r);
          } catch {
            // History/UI hook failures must not fail the item.
          }
        }
        return;
      } catch (e) {
        // Expired signed CDN URL → re-probe the source once (batch-wide)
        // and retry this item with its fresh URL instead of failing it.
        const expired =
          e instanceof HttpStatusError && [401, 403, 404, 410, 429].includes(e.status);
        if (expired && !refreshed && entry.directUrl && sourceUrl) {
          refreshed = true;
          try {
            const fresh = (await refreshEntries()).get(entry.id);
            if (fresh?.directUrl) {
              entry = { ...entry, directUrl: fresh.directUrl, variants: fresh.variants ?? null };
              // The failed attempt's error-body transfer may have pushed
              // this slot toward 100 — reset so the bar doesn't lie, then
              // let the loop's cancel check gate the actual retry.
              perItemPct[i] = 0;
              continue;
            }
          } catch (probeErr) {
            logError("download", probeErr, `refresh of ${sourceUrl}`);
          }
        }
        // Count the failed slot as "complete" for the bar — without this
        // a batch with any failure could never reach 100%.
        perItemPct[i] = 100;
        reportOverall();
        remaining.delete(entry.id);
        persistRemaining();
        logError("download", e, entry.title);
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

  // A previous batch that was cancelled mid-item leaves cancelRequested
  // set (the cancelled early-return path doesn't clear it). Reset here so
  // a fresh batch isn't aborted on iteration 0.
  cancelRequested = false;

  batchActive = true;
  setKeepAwakeSafe(true);
  persistRemaining();
  try {
    const directIdx = [];
    const ytdlpIdx = [];
    entries.forEach((e, i) => {
      (isDirectLane(e, audioOnly) ? directIdx : ytdlpIdx).push(i);
    });

    // Direct pool: DIRECT_CONCURRENCY workers pulling from a shared
    // cursor. yt-dlp lane: strictly sequential (python process per item).
    // Both lanes run at the same time and stop pulling once cancelled.
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
      return { results, errors, cancelled: true };
    }
    return { results, errors, cancelled: false };
  } finally {
    // The descriptor exists to survive the PROCESS DYING mid-batch. If we
    // reached here at all — success, cancel, or a thrown error — the app is
    // alive and the user can see the outcome, so offering to "resume" on the
    // next launch would be a phantom banner for work that already finished.
    // (A batch that threw previously left its descriptor behind forever.)
    clearPendingBatch();
    batchActive = false;
    setKeepAwakeSafe(false);
    if (unsubProgress) {
      try {
        unsubProgress();
      } catch {
        // ignore
      }
    }
  }
}
