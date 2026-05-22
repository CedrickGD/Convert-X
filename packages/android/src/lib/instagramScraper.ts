/**
 * Anonymous Instagram scraper.
 *
 * yt-dlp's Instagram extractor hits API endpoints that Instagram has
 * locked behind auth since 2024 — even for posts that are perfectly
 * viewable in a browser without login. snapinsta.to and similar
 * downloader sites bypass this by hitting Instagram's public *embed*
 * endpoint with a normal browser User-Agent: that path still serves
 * the post's media URLs inline because it has to render the embed for
 * any blog/site that includes an Instagram post.
 *
 * For carousels (multi-image posts) the embed page's inline JSON
 * carries every child via graphql.shortcode_media.edge_sidecar_to_children.
 * For single-image and single-video posts the og:image / og:video meta
 * tags are enough.
 *
 * Private posts still require an authenticated session — the embed
 * endpoint refuses them. The caller's contract is to fall through to
 * the cookied yt-dlp path on a thrown error.
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

function decodeUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

type ScrapedNode = {
  is_video?: boolean;
  display_url?: string;
  video_url?: string;
  shortcode?: string;
};

type ShortcodeMedia = ScrapedNode & {
  edge_sidecar_to_children?: {
    edges?: Array<{ node?: ScrapedNode }>;
  };
};

function findShortcodeMedia(html: string): ShortcodeMedia | null {
  // The embed page emits one or more of these — each is a JSON payload
  // passed to window.__additionalDataLoaded. We try each occurrence and
  // pick the first one that parses and contains a shortcode_media node.
  const re = /window\.__additionalDataLoaded\('[^']*',\s*(\{.*?\})\);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as Record<string, unknown>;
      const graphql = (parsed.graphql ?? parsed) as Record<string, unknown> | undefined;
      const media =
        (graphql?.shortcode_media as ShortcodeMedia | undefined) ??
        ((parsed as Record<string, unknown>).shortcode_media as ShortcodeMedia | undefined);
      if (media) return media;
    } catch {
      // Continue to next match.
    }
  }
  return null;
}

function nodeToEntry(
  node: ScrapedNode,
  base: { shortcode: string; idx: number }
): DownloadEntry & { directUrl: string } {
  const isVideo = !!node.is_video;
  const directUrl = isVideo ? node.video_url ?? '' : node.display_url ?? '';
  return {
    id: `${base.shortcode}-${base.idx}`,
    title: `Instagram-${base.shortcode}-${base.idx + 1}`,
    thumbnail: node.display_url,
    webpageUrl: `https://www.instagram.com/p/${base.shortcode}/`,
    directUrl,
  };
}

/**
 * Probe a public Instagram post URL anonymously.
 *
 * Throws if the post is private, the URL is malformed, or Instagram
 * has further locked down the embed endpoint. Caller should fall back
 * to the authenticated yt-dlp path on any throw.
 */
export async function probeInstagramAnonymous(url: string): Promise<ProbeResult> {
  const shortcode = extractShortcode(url);
  if (!shortcode) throw new Error('Not a recognizable Instagram post URL.');

  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
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

  const entries: Array<DownloadEntry & { directUrl: string }> = [];

  // Preferred path: inline JSON via window.__additionalDataLoaded.
  // Gives us every carousel child, complete with video_url where the
  // child is a video.
  const media = findShortcodeMedia(html);
  if (media) {
    const children = media.edge_sidecar_to_children?.edges ?? [];
    if (children.length > 0) {
      for (let i = 0; i < children.length; i += 1) {
        const node = children[i].node;
        if (!node) continue;
        entries.push(nodeToEntry(node, { shortcode, idx: i }));
      }
    } else {
      entries.push(nodeToEntry(media, { shortcode, idx: 0 }));
    }
  }

  // Fallback path: og:video / og:image meta tags. Single-item only,
  // but covers cases where Instagram drops the inline JSON.
  if (entries.length === 0) {
    const ogVideo = html.match(/<meta property="og:video" content="([^"]+)"/);
    const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/);
    const directRaw = ogVideo?.[1] ?? ogImage?.[1];
    if (directRaw) {
      const directUrl = decodeHtmlEntities(decodeUnicode(directRaw));
      entries.push({
        id: `${shortcode}-0`,
        title: `Instagram-${shortcode}`,
        thumbnail: ogImage ? decodeHtmlEntities(decodeUnicode(ogImage[1])) : undefined,
        webpageUrl: `https://www.instagram.com/p/${shortcode}/`,
        directUrl,
      });
    }
  }

  if (entries.length === 0) {
    throw new Error(
      'Anonymous Instagram scrape returned nothing — post may be private, deleted, or Instagram tightened the embed endpoint.'
    );
  }

  return {
    site: 'Instagram',
    isPlaylist: entries.length > 1,
    entries,
  };
}
