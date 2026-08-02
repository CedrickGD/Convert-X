/**
 * Anonymous Twitter/X scraper.
 *
 * yt-dlp errors on pure-photo tweets ("No video could be found in this
 * tweet") because its extractor only builds formats from video variants.
 * Twitter's syndication CDN (cdn.syndication.twimg.com/tweet-result) is
 * the JSON backend every embedded-tweet widget uses — it serves public
 * tweet metadata (photos, videos, animated GIFs) without auth, keyed by
 * the status id plus a token every embed client derives the same way.
 * We map each media item to a direct CDN entry so photos download over
 * plain HTTPS and videos skip the yt-dlp round trip entirely.
 *
 * All network goes through platform.httpRequest (a Rust reqwest command)
 * — a plain fetch() from the webview would be CORS-blocked. On web the
 * method is absent and the prober throws, which the router treats as a
 * fallthrough.
 *
 * Caveats:
 *  - Protected / deleted / NSFW-gated tweets come back as a tombstone
 *    (or empty payload) — those need the cookied yt-dlp path, so we
 *    throw with a "log in via cookies" hint and let the caller fall
 *    through.
 *  - The top-level `photos` / `video` fields only carry the FIRST video
 *    of a multi-video tweet; `mediaDetails` carries every item. We
 *    prefer `mediaDetails` and use photos/video only as a fallback for
 *    older payload shapes.
 */

import { getPlatform } from "../platform.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Host must sit at the string start or right after the protocol so
// "netflix.com/…" can't substring-match "x.com/…". `i/web/status/…`
// share links carry no screen name — the API response supplies it.
const STATUS_RE =
  /(?:^|\/\/)(?:www\.|m\.|mobile\.)?(?:twitter|x)\.com\/(?:i\/web\/|[A-Za-z0-9_]+\/)status(?:es)?\/(\d+)/;

export function isTwitterStatusUrl(url) {
  return STATUS_RE.test(url);
}

function extractStatusId(url) {
  const m = url.match(STATUS_RE);
  return m ? m[1] : null;
}

/**
 * The `token` query param the syndication endpoint requires. Publicly
 * documented and derived identically by every embed client: the status
 * id scaled down, multiplied by π, base-36, zeros and the dot stripped.
 */
function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/** pbs.twimg.com serves the embed-sized rendition by default — `name=orig`
 *  asks for the full-resolution original. */
function origSize(url) {
  return url.includes("?") ? `${url}&name=orig` : `${url}?name=orig`;
}

/** Highest-quality mp4 out of a variant list. Prefers bitrate when the
 *  shape carries it; otherwise keeps the last mp4 (Twitter lists them
 *  ascending: 480p → 720p). Returns null when only HLS exists.
 *  mediaDetails[].video_info.variants uses url/content_type/bitrate; the
 *  top-level video.variants fallback uses src/type and no bitrate. */
function bestMp4(variants) {
  let best = null;
  let bestScore = -1;
  variants.forEach((v, i) => {
    const contentType = v.content_type ?? v.type ?? "";
    const url = v.url ?? v.src;
    if (contentType !== "video/mp4" || typeof url !== "string") return;
    const score = typeof v.bitrate === "number" ? v.bitrate : i;
    if (score >= bestScore) {
      bestScore = score;
      best = url;
    }
  });
  return best;
}

/** Every mp4 encode with its dimensions, so the download step can honor
 *  the user's quality cap. Syndication variants carry no width/height
 *  fields — but the CDN path embeds them (`…/vid/avc1/720x1280/….mp4`). */
function mp4Variants(variants) {
  const out = [];
  for (const v of variants) {
    const contentType = v.content_type ?? v.type ?? "";
    const url = v.url ?? v.src;
    if (contentType !== "video/mp4" || typeof url !== "string") continue;
    const dims = url.match(/\/(\d{2,5})x(\d{2,5})\//);
    out.push({
      url,
      width: dims ? parseInt(dims[1], 10) : undefined,
      height: dims ? parseInt(dims[2], 10) : undefined,
    });
  }
  return out;
}

async function httpGet(url, headers) {
  const platform = getPlatform();
  if (typeof platform.httpRequest !== "function") {
    throw new Error("URL probing requires the desktop app.");
  }
  try {
    // 15s timeout so a captive portal / slow CDN can't hang "Loading…" forever.
    return await platform.httpRequest({ url, method: "GET", headers, timeoutMs: 15000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timed?\s?-?out|timeout/i.test(msg)) {
      throw new Error("Twitter took too long to respond — check your connection and try again.");
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}

/**
 * Probe a public tweet URL anonymously via the syndication CDN.
 *
 * Throws when the tweet is text-only, tombstoned (protected / deleted /
 * NSFW-gated), or the endpoint is unreachable. Caller should surface
 * the message and fall through to the cookied yt-dlp path.
 */
export async function probeTwitterAnonymous(url) {
  const statusId = extractStatusId(url);
  if (!statusId) throw new Error("Not a recognizable Twitter/X status URL.");

  const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=${syndicationToken(
    statusId
  )}&lang=en`;
  const resp = await httpGet(apiUrl, {
    "User-Agent": BROWSER_UA,
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
  });
  if (resp.status < 200 || resp.status >= 300) {
    // 404 is what the endpoint returns for nonexistent ids.
    throw new Error(
      resp.status === 404
        ? "Tweet not found — it may have been deleted."
        : `Twitter returned HTTP ${resp.status}`
    );
  }
  let data;
  try {
    data = JSON.parse(resp.body);
  } catch {
    throw new Error("Twitter returned an unreadable response.");
  }

  // Age-gated / protected / withheld tweets serve a tombstone instead of
  // the tweet body. Anonymous access is a hard wall here — only cookies
  // get through.
  if (data.__typename === "TweetTombstone" || data.tombstone != null) {
    throw new Error(
      "This tweet is protected, deleted, or NSFW-gated — import an X cookies.txt under Credits to access it."
    );
  }

  const user = data.user;
  const screenName = user && typeof user.screen_name === "string" ? user.screen_name : "i";
  const webpageUrl = `https://x.com/${screenName}/status/${statusId}`;

  // Collect media. mediaDetails is authoritative — the top-level
  // photos/video pair only describes the first video of a multi-video
  // tweet — but keep the legacy shape as a fallback.
  const media = [];
  const details = data.mediaDetails;

  if (Array.isArray(details) && details.length > 0) {
    for (const d of details) {
      if (d.type === "photo" && typeof d.media_url_https === "string") {
        media.push({
          kind: "image",
          directUrl: origSize(d.media_url_https),
          thumbnail: d.media_url_https,
        });
      } else if (
        (d.type === "video" || d.type === "animated_gif") &&
        Array.isArray(d.video_info?.variants)
      ) {
        const mp4 = bestMp4(d.video_info.variants);
        if (mp4) {
          media.push({
            kind: "video",
            directUrl: mp4,
            thumbnail: d.media_url_https,
            durationMs: d.video_info.duration_millis,
            variants: mp4Variants(d.video_info.variants),
          });
        }
      }
    }
  } else {
    const photos = data.photos;
    for (const p of Array.isArray(photos) ? photos : []) {
      if (typeof p.url === "string") {
        media.push({ kind: "image", directUrl: origSize(p.url), thumbnail: p.url });
      }
    }
    const video = data.video;
    if (Array.isArray(video?.variants)) {
      const mp4 = bestMp4(video.variants);
      if (mp4) {
        media.push({
          kind: "video",
          directUrl: mp4,
          thumbnail: video.poster,
          durationMs: video.durationMs,
          variants: mp4Variants(video.variants),
        });
      }
    }
  }

  if (media.length === 0) {
    throw new Error("This tweet has no downloadable media.");
  }

  // Unique titles are REQUIRED for multi-item tweets — the direct
  // downloader derives filenames from them, and identical names would
  // make item 2..n overwrite item 1.
  const baseTitle = `Twitter-${screenName}-${statusId}`;
  const entries = media.map((m, i) => ({
    id: `${statusId}-${i + 1}`,
    title: media.length > 1 ? `${baseTitle}-${i + 1}` : baseTitle,
    url: webpageUrl,
    sourceUrl: url,
    // Fallback paths (Audio toggle, expired CDN URL → yt-dlp) hand the
    // shared tweet URL to yt-dlp — the 1-based position scopes those to
    // THIS item instead of re-fetching the whole multi-media tweet.
    playlistIndex: media.length > 1 ? i + 1 : null,
    mediaType: m.kind,
    thumbnail: m.thumbnail ?? null,
    directUrl: m.directUrl,
    variants: m.variants && m.variants.length > 0 ? m.variants : null,
    duration: m.durationMs != null ? Math.round(m.durationMs / 1000) : null,
    uploader: screenName,
    partialCarousel: false,
  }));

  return {
    site: "Twitter/X",
    isPlaylist: entries.length > 1,
    entries,
  };
}
