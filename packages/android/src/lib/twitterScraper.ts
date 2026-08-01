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

import type { DownloadEntry, ProbeResult } from './downloadQueue';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Host must sit at the string start or right after the protocol so
// "netflix.com/…" can't substring-match "x.com/…". `i/web/status/…`
// share links carry no screen name — the API response supplies it.
const STATUS_RE =
  /(?:^|\/\/)(?:www\.|m\.|mobile\.)?(?:twitter|x)\.com\/(?:i\/web\/|[A-Za-z0-9_]+\/)status(?:es)?\/(\d+)/;

export function isTwitterStatusUrl(url: string): boolean {
  return STATUS_RE.test(url);
}

function extractStatusId(url: string): string | null {
  const m = url.match(STATUS_RE);
  return m ? m[1] : null;
}

/**
 * The `token` query param the syndication endpoint requires. Publicly
 * documented and derived identically by every embed client: the status
 * id scaled down, multiplied by π, base-36, zeros and the dot stripped.
 */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

/** pbs.twimg.com serves the embed-sized rendition by default — `name=orig`
 *  asks for the full-resolution original. */
function origSize(url: string): string {
  return url.includes('?') ? `${url}&name=orig` : `${url}?name=orig`;
}

type SyndicationVariant = {
  // mediaDetails[].video_info.variants uses url/content_type/bitrate;
  // the top-level video.variants fallback uses src/type and no bitrate.
  url?: string;
  src?: string;
  bitrate?: number;
  content_type?: string;
  type?: string;
};

/** Highest-quality mp4 out of a variant list. Prefers bitrate when the
 *  shape carries it; otherwise keeps the last mp4 (Twitter lists them
 *  ascending: 480p → 720p). Returns null when only HLS exists. */
function bestMp4(variants: SyndicationVariant[]): string | null {
  let best: string | null = null;
  let bestScore = -1;
  variants.forEach((v, i) => {
    const contentType = v.content_type ?? v.type ?? '';
    const url = v.url ?? v.src;
    if (contentType !== 'video/mp4' || typeof url !== 'string') return;
    const score = typeof v.bitrate === 'number' ? v.bitrate : i;
    if (score >= bestScore) {
      bestScore = score;
      best = url;
    }
  });
  return best;
}

type RawMedia = {
  kind: 'image' | 'video';
  directUrl: string;
  thumbnail?: string;
  durationMs?: number;
  variants?: Array<{ url: string; width?: number; height?: number }>;
};

/** Every mp4 encode with its dimensions, so the download step can honor
 *  the user's quality cap. Syndication variants carry no width/height
 *  fields — but the CDN path embeds them (`…/vid/avc1/720x1280/….mp4`). */
function mp4Variants(
  variants: SyndicationVariant[]
): Array<{ url: string; width?: number; height?: number }> {
  const out: Array<{ url: string; width?: number; height?: number }> = [];
  for (const v of variants) {
    const contentType = v.content_type ?? v.type ?? '';
    const url = v.url ?? v.src;
    if (contentType !== 'video/mp4' || typeof url !== 'string') continue;
    const dims = url.match(/\/(\d{2,5})x(\d{2,5})\//);
    out.push({
      url,
      width: dims ? parseInt(dims[1], 10) : undefined,
      height: dims ? parseInt(dims[2], 10) : undefined,
    });
  }
  return out;
}

/**
 * Probe a public tweet URL anonymously via the syndication CDN.
 *
 * Throws when the tweet is text-only, tombstoned (protected / deleted /
 * NSFW-gated), or the endpoint is unreachable. Caller should surface
 * the message and fall through to the cookied yt-dlp path.
 */
export async function probeTwitterAnonymous(url: string): Promise<ProbeResult> {
  const statusId = extractStatusId(url);
  if (!statusId) throw new Error('Not a recognizable Twitter/X status URL.');

  const apiUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${statusId}&token=${syndicationToken(
    statusId
  )}&lang=en`;
  // 15s timeout so a captive portal / slow CDN can't hang "Loading…" forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let data: Record<string, unknown>;
  try {
    const resp = await fetch(apiUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      // 404 is what the endpoint returns for nonexistent ids.
      throw new Error(
        resp.status === 404
          ? 'Tweet not found — it may have been deleted.'
          : `Twitter returned HTTP ${resp.status}`
      );
    }
    data = (await resp.json()) as Record<string, unknown>;
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error('Twitter took too long to respond — check your connection and try again.');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  // Age-gated / protected / withheld tweets serve a tombstone instead of
  // the tweet body. Anonymous access is a hard wall here — only cookies
  // get through.
  if (data.__typename === 'TweetTombstone' || data.tombstone != null) {
    throw new Error(
      'This tweet is protected, deleted, or NSFW-gated — import an X cookies.txt under Credits to access it.'
    );
  }

  const user = data.user as { screen_name?: string } | undefined;
  const screenName = user?.screen_name ?? 'i';
  const webpageUrl = `https://x.com/${screenName}/status/${statusId}`;

  // Collect media. mediaDetails is authoritative — the top-level
  // photos/video pair only describes the first video of a multi-video
  // tweet — but keep the legacy shape as a fallback.
  const media: RawMedia[] = [];
  const details = data.mediaDetails as
    | Array<{
        type?: string;
        media_url_https?: string;
        video_info?: { variants?: SyndicationVariant[]; duration_millis?: number };
      }>
    | undefined;

  if (Array.isArray(details) && details.length > 0) {
    for (const d of details) {
      if (d.type === 'photo' && typeof d.media_url_https === 'string') {
        media.push({
          kind: 'image',
          directUrl: origSize(d.media_url_https),
          thumbnail: d.media_url_https,
        });
      } else if (
        (d.type === 'video' || d.type === 'animated_gif') &&
        Array.isArray(d.video_info?.variants)
      ) {
        const mp4 = bestMp4(d.video_info.variants);
        if (mp4) {
          media.push({
            kind: 'video',
            directUrl: mp4,
            thumbnail: d.media_url_https,
            durationMs: d.video_info.duration_millis,
            variants: mp4Variants(d.video_info.variants),
          });
        }
      }
    }
  } else {
    const photos = data.photos as Array<{ url?: string }> | undefined;
    for (const p of photos ?? []) {
      if (typeof p.url === 'string') {
        media.push({ kind: 'image', directUrl: origSize(p.url), thumbnail: p.url });
      }
    }
    const video = data.video as
      | { variants?: SyndicationVariant[]; poster?: string; durationMs?: number }
      | undefined;
    if (Array.isArray(video?.variants)) {
      const mp4 = bestMp4(video.variants);
      if (mp4) {
        media.push({
          kind: 'video',
          directUrl: mp4,
          thumbnail: video.poster,
          durationMs: video.durationMs,
          variants: mp4Variants(video.variants),
        });
      }
    }
  }

  if (media.length === 0) {
    throw new Error('This tweet has no downloadable media.');
  }

  // Unique titles are REQUIRED for multi-item tweets — the direct
  // downloader derives filenames from them, and identical names would
  // make item 2..n overwrite item 1.
  const baseTitle = `Twitter-${screenName}-${statusId}`;
  const entries: DownloadEntry[] = media.map((m, i) => ({
    id: `${statusId}-${i}`,
    title: media.length > 1 ? `${baseTitle}-${i + 1}` : baseTitle,
    thumbnail: m.thumbnail,
    duration: m.durationMs != null ? Math.round(m.durationMs / 1000) : undefined,
    mediaType: m.kind,
    webpageUrl,
    directUrl: m.directUrl,
    variants: m.variants && m.variants.length > 0 ? m.variants : undefined,
    // Fallback paths (Audio toggle, expired CDN URL → yt-dlp) hand the
    // shared tweet URL to yt-dlp — the 1-based position scopes those to
    // THIS item instead of re-fetching the whole multi-media tweet.
    playlistIndex: media.length > 1 ? i + 1 : undefined,
  }));

  return {
    site: 'Twitter/X',
    isPlaylist: entries.length > 1,
    entries,
  };
}
