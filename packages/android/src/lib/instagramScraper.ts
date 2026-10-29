/**
 * Anonymous Instagram embed scraper — last JS fallback for public posts.
 *
 * The public /embed/ endpoint serves a static HTML fragment that blog
 * embeds and snapinsta-style downloaders harvest. It is the one Instagram
 * surface that has never cared who asks, which makes it the safety net
 * under the logged-out GraphQL prober (instagramStories.ts) — that one
 * depends on a persisted query id Instagram rotates every year or two.
 *
 * Two sources inside the page, newest first:
 *  1. `contextJSON` — a JSON string carrying `gql_data.shortcode_media`,
 *     i.e. the classic GraphQL post object: `edge_sidecar_to_children`
 *     with EVERY carousel child, `video_url` for videos, `display_url`
 *     for photos. Full carousels, no login.
 *  2. The rendered `<img class="EmbeddedMediaImage">` /
 *     `<video class="EmbeddedMediaVideo">` tags — first item only.
 *
 * Caveats:
 *  - Instagram omits `video_url` for some reels (copyright-blocked,
 *    "login to watch"); the page then only carries the poster frame. We
 *    throw instead of handing back a JPG for a video the user asked for.
 *  - Private posts render a login shell with no media at all.
 */

import type { DownloadEntry, ProbeResult } from './downloadQueue';
import { igRequest } from './instagramNet';
import { InstagramError, instagramMessage, instagramPostShortcode } from './instagramStories';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

export function isInstagramPostUrl(url: string): boolean {
  return instagramPostShortcode(url) !== null;
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

type GqlNode = {
  __typename?: string;
  id?: string;
  shortcode?: string;
  is_video?: boolean;
  video_url?: string;
  display_url?: string;
  video_duration?: number;
  dimensions?: { width?: number; height?: number };
  edge_sidecar_to_children?: { edges?: Array<{ node?: GqlNode }> };
};

/** Pull `gql_data.shortcode_media` out of the embed page, if present. */
function parseContextJson(html: string): GqlNode | null {
  const m = html.match(/"contextJSON":"((?:\\.|[^"\\])*)"/);
  if (!m) return null;
  try {
    // The attribute holds a JSON string literal whose VALUE is JSON.
    const inner = JSON.parse(`"${m[1]}"`) as string;
    const ctx = JSON.parse(inner) as { gql_data?: { shortcode_media?: GqlNode } };
    return ctx.gql_data?.shortcode_media ?? null;
  } catch {
    return null;
  }
}

function entryFromNode(
  node: GqlNode,
  title: string,
  webpageUrl: string,
  fallbackId: string
): { entry: DownloadEntry | null; lockedVideo: boolean } {
  const id = String(node.id ?? node.shortcode ?? fallbackId);
  if (node.is_video) {
    if (!node.video_url) return { entry: null, lockedVideo: true };
    return {
      entry: {
        id,
        title,
        thumbnail: node.display_url,
        duration: typeof node.video_duration === 'number' ? node.video_duration : undefined,
        mediaType: 'video',
        webpageUrl,
        directUrl: node.video_url,
        variants: [
          {
            url: node.video_url,
            width: node.dimensions?.width,
            height: node.dimensions?.height,
          },
        ],
      },
      lockedVideo: false,
    };
  }
  if (!node.display_url) return { entry: null, lockedVideo: false };
  return {
    entry: {
      id,
      title,
      thumbnail: node.display_url,
      mediaType: 'image',
      webpageUrl,
      directUrl: node.display_url,
    },
    lockedVideo: false,
  };
}

/**
 * Probe a public Instagram post via /embed/. Throws an InstagramError
 * ('login_required') when the post is private or its video is withheld
 * from anonymous viewers, so the caller's error composition can offer
 * the one-tap login.
 */
export async function probeInstagramEmbed(url: string): Promise<ProbeResult> {
  const shortcode = instagramPostShortcode(url);
  if (!shortcode) throw new Error('Not a recognizable Instagram post URL.');

  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
  const webpageUrl = `https://www.instagram.com/p/${shortcode}/`;
  const resp = await igRequest(embedUrl, {
    mode: 'anonymous',
    userAgent: MOBILE_UA,
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeoutMs: 15000,
  });
  if (resp.status === 404) throw new InstagramError('not_found', instagramMessage('not_found'));
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Instagram embed returned HTTP ${resp.status}`);
  }
  const html = resp.body;

  // 1. Structured data — every carousel child, real video URLs.
  const media = parseContextJson(html);
  if (media) {
    const nodes =
      media.edge_sidecar_to_children?.edges
        ?.map((e) => e.node)
        .filter((n): n is GqlNode => !!n) ?? [];
    const children = nodes.length > 0 ? nodes : [media];
    const entries: DownloadEntry[] = [];
    let locked = 0;
    children.forEach((node, i) => {
      const title =
        children.length > 1 ? `Instagram-${shortcode}-${i + 1}` : `Instagram-${shortcode}`;
      const { entry, lockedVideo } = entryFromNode(node, title, webpageUrl, `${shortcode}-${i}`);
      if (entry) entries.push(entry);
      if (lockedVideo) locked += 1;
    });
    if (entries.length === 0) {
      // A video post whose embed only carries the poster: Instagram keeps
      // the stream for logged-in viewers (or yt-dlp's cookied path).
      throw new InstagramError(
        locked > 0 ? 'login_required' : 'other',
        locked > 0
          ? 'Instagram withholds this video from anonymous viewers — log in to Instagram under Credits to download it.'
          : 'Instagram embed carried no media for this post.'
      );
    }
    if (locked > 0) for (const e of entries) e.partialCarousel = true;
    return { site: 'Instagram', isPlaylist: entries.length > 1, entries };
  }

  // 2. Rendered tags — first item only. Order matters: a video post also
  // has a poster <img>, so prefer the <video> tag when both exist.
  const videoMatch = html.match(/<video[^>]*class="EmbeddedMediaVideo"[^>]*src="([^"]+)"/);
  const imageMatch = html.match(/<img[^>]*class="EmbeddedMediaImage"[^>]*src="([^"]+)"/);
  const saysVideo = /"is_video"\s*:\s*true|GraphVideo|EmbeddedMediaVideo/.test(html);
  if (!videoMatch && saysVideo) {
    throw new InstagramError(
      'login_required',
      'Instagram withholds this video from anonymous viewers — log in to Instagram under Credits to download it.'
    );
  }
  const captureGroup = videoMatch?.[1] ?? imageMatch?.[1];
  if (!captureGroup) {
    // No media and no data: the login shell (private post) or Instagram's
    // JS-only A/B variant of the embed.
    const kind = /accounts\/login|Log in to Instagram|\bprivate\b/i.test(html) ? 'login_required' : 'other';
    throw new InstagramError(
      kind,
      kind === 'login_required'
        ? instagramMessage('login_required')
        : 'Instagram served the embed without any media — try again, or log in under Credits.'
    );
  }

  const entry: DownloadEntry = {
    id: `${shortcode}-0`,
    title: `Instagram-${shortcode}`,
    thumbnail: imageMatch ? decodeHtmlEntities(imageMatch[1]) : undefined,
    mediaType: videoMatch ? 'video' : 'image',
    webpageUrl,
    directUrl: decodeHtmlEntities(captureGroup),
  };
  // Only the first item is retrievable this way; flag carousels so the UI
  // can say the rest need a login.
  if ((html.match(/class="CarouselNavThumb"/g) ?? []).length > 0) entry.partialCarousel = true;

  return { site: 'Instagram', isPlaylist: false, entries: [entry] };
}

/** @deprecated kept for callers that predate the chain in downloadQueue. */
export const probeInstagramAnonymous = probeInstagramEmbed;
