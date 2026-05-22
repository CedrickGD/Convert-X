/**
 * Anonymous Instagram scraper.
 *
 * Instagram's API path (which yt-dlp uses) requires auth cookies for
 * essentially every post since 2024. The public /embed/ endpoint
 * however serves a static HTML fragment with the post's media URL
 * baked in — that's what blog posts and tweet embeds use, and it's
 * what snapinsta-style downloaders harvest. We parse the
 * <img class="EmbeddedMediaImage" ... src="..."> tag (or the matching
 * EmbeddedMediaVideo for video posts) and download the CDN URL
 * directly.
 *
 * Caveats:
 *  - Instagram appears to A/B test the embed endpoint — some URLs
 *    serve the static HTML, others get a JS shell with no inline
 *    media URLs. We throw on the shell case and let the caller fall
 *    through to the cookied yt-dlp path.
 *  - For carousel posts the embed always shows the first item; other
 *    items are only available via the authenticated API. The user
 *    needs to log in (Credits → Login) to grab the rest.
 */

import type { DownloadEntry, ProbeResult } from './downloadQueue';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const SHORTCODE_RE = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/;

export function isInstagramPostUrl(url: string): boolean {
  return SHORTCODE_RE.test(url);
}

function extractShortcode(url: string): string | null {
  const m = url.match(SHORTCODE_RE);
  return m ? m[1] : null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#064;/g, '@')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Probe a public Instagram post URL anonymously via /embed/.
 *
 * Throws when the embed returns a JS shell (Instagram's A/B-tested
 * "no inline media" variant) or when the post is private. Caller
 * should surface a "this Instagram post needs login" hint and fall
 * through to the cookied yt-dlp path.
 */
export async function probeInstagramAnonymous(url: string): Promise<ProbeResult> {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Not a recognizable Instagram post URL.');

  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
  const resp = await fetch(embedUrl, {
    headers: {
      'User-Agent': MOBILE_UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!resp.ok) {
    throw new Error(`Instagram embed returned HTTP ${resp.status}`);
  }
  const html = await resp.text();

  // Walk both possible tag shapes — image and video. Order matters:
  // a video post sometimes also has a poster <img>, so we prefer the
  // <video> tag when both are present.
  const videoMatch = html.match(
    /<video[^>]*class="EmbeddedMediaVideo"[^>]*src="([^"]+)"/
  );
  const imageMatch = html.match(
    /<img[^>]*class="EmbeddedMediaImage"[^>]*src="([^"]+)"/
  );
  const captureGroup = videoMatch?.[1] ?? imageMatch?.[1];

  if (!captureGroup) {
    throw new Error(
      'Instagram blocked anonymous access to this post — tap Login in Credits to sign in.'
    );
  }

  const directUrl = decodeHtmlEntities(captureGroup);
  const entry: DownloadEntry & { directUrl: string } = {
    id: `${shortcode}-0`,
    title: `Instagram-${shortcode}`,
    thumbnail: imageMatch ? decodeHtmlEntities(imageMatch[1]) : undefined,
    webpageUrl: `https://www.instagram.com/p/${shortcode}/`,
    directUrl,
  };

  // The embed page only carries the first item of a carousel — if the
  // page references additional carousel images at small (preview)
  // sizes the rest are gated behind login. Detect that and warn the
  // user before they tap Download expecting all 10 photos.
  const carouselThumbCount = (html.match(/class="CarouselNavThumb"/g) ?? []).length;
  if (carouselThumbCount > 0) {
    // We still return the first item so a partial download is possible
    // — but flag the result so the UI can prompt the user to log in
    // for full carousel access. We use a sentinel field on the title;
    // the UI surfaces this as an "only item 1 of N" hint.
    entry.title = `${entry.title}-of-carousel`;
  }

  return {
    site: 'Instagram',
    isPlaylist: false,
    entries: [entry],
  };
}
