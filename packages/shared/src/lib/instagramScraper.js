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
 * All network goes through platform.httpRequest (a Rust reqwest command)
 * — a plain fetch() from the webview would be CORS-blocked.
 *
 * Caveats:
 *  - Instagram appears to A/B test the embed endpoint — some URLs
 *    serve the static HTML, others get a JS shell with no inline
 *    media URLs. We throw on the shell case and let the caller fall
 *    through to the cookied yt-dlp path.
 *  - For carousel posts the embed always shows the first item; other
 *    items are only available via the authenticated API. The user
 *    needs to log in (Credits → Platform logins) to grab the rest.
 */

import { getPlatform } from "../platform.js";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

const SHORTCODE_RE = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/;

export function isInstagramPostUrl(url) {
  return SHORTCODE_RE.test(url);
}

function extractShortcode(url) {
  const m = url.match(SHORTCODE_RE);
  return m ? m[1] : null;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#064;/g, "@")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Probe a public Instagram post URL anonymously via /embed/.
 *
 * Throws when the embed returns a JS shell (Instagram's A/B-tested
 * "no inline media" variant) or when the post is private. Caller
 * should surface a "this Instagram post needs login" hint and fall
 * through to the cookied yt-dlp path.
 */
export async function probeInstagramAnonymous(url) {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error("Not a recognizable Instagram post URL.");

  const platform = getPlatform();
  if (typeof platform.httpRequest !== "function") {
    throw new Error("URL probing requires the desktop app.");
  }

  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
  let resp;
  try {
    // 15s timeout so a captive portal / slow CDN can't hang "Loading…" forever.
    resp = await platform.httpRequest({
      url: embedUrl,
      method: "GET",
      headers: {
        "User-Agent": MOBILE_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      timeoutMs: 15000,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timed?\s?-?out|timeout/i.test(msg)) {
      throw new Error("Instagram took too long to respond — check your connection and try again.");
    }
    throw e instanceof Error ? e : new Error(msg);
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Instagram embed returned HTTP ${resp.status}`);
  }
  const html = resp.body;

  // Walk both possible tag shapes — image and video. Order matters:
  // a video post sometimes also has a poster <img>, so we prefer the
  // <video> tag when both are present.
  const videoMatch = html.match(/<video[^>]*class="EmbeddedMediaVideo"[^>]*src="([^"]+)"/);
  const imageMatch = html.match(/<img[^>]*class="EmbeddedMediaImage"[^>]*src="([^"]+)"/);
  const captureGroup = videoMatch?.[1] ?? imageMatch?.[1];

  if (!captureGroup) {
    throw new Error(
      "Instagram blocked anonymous access to this post — log in under Credits → Platform logins."
    );
  }

  const directUrl = decodeHtmlEntities(captureGroup);
  const entry = {
    id: `${shortcode}-0`,
    title: `Instagram-${shortcode}`,
    url: `https://www.instagram.com/p/${shortcode}/`,
    sourceUrl: url,
    playlistIndex: null,
    // A <video> tag means a reel/video post; otherwise it's a photo.
    mediaType: videoMatch ? "video" : "image",
    thumbnail: imageMatch ? decodeHtmlEntities(imageMatch[1]) : null,
    directUrl,
    variants: null,
    duration: null,
    uploader: null,
    partialCarousel: false,
  };

  // The embed page only carries the first item of a carousel — if the
  // page references additional carousel images at small (preview)
  // sizes the rest are gated behind login. Detect that and warn the
  // user before they hit Download expecting all 10 photos.
  const carouselThumbCount = (html.match(/class="CarouselNavThumb"/g) ?? []).length;
  if (carouselThumbCount > 0) {
    // Only the first item is retrievable anonymously; the rest are gated
    // behind login. Flag it structurally so the UI can show a notice —
    // without leaking a sentinel into the visible title / saved filename.
    entry.partialCarousel = true;
  }

  return {
    site: "Instagram",
    isPlaylist: false,
    entries: [entry],
  };
}
