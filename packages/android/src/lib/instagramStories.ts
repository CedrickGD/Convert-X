/**
 * Cookied Instagram story prober.
 *
 * yt-dlp's instagram:story extractor builds formats exclusively from
 * `video_versions` and silently drops story items without them — i.e.
 * every PHOTO story item. A two-item story of [photo, video] probes as
 * just the video and the photo can never be downloaded. Stories always
 * require login anyway, so when Instagram cookies exist we skip yt-dlp
 * and call the same private web API it would use (feed/reels_media),
 * mapping EVERY item — photos included — to a direct CDN URL that the
 * existing downloadDirect path fetches without yt-dlp.
 *
 * Endpoints (mirrors yt-dlp's InstagramBaseIE in web-app mode):
 *   - /api/v1/users/web_profile_info/?username=X  → story owner's user id
 *   - /api/v1/feed/reels_media/?reel_ids=Y        → story/highlight items
 * Both need the X-IG-App-ID header plus the logged-in session cookies.
 */

import type { DownloadEntry, ProbeResult } from './downloadQueue';
import { getCookieHeaderForDomain, getCookieValue } from './cookies';
import { LOGIN_USER_AGENT } from './loginPlatforms';

const API_BASE = 'https://www.instagram.com/api/v1';
/** Instagram's public web-app id — same constant yt-dlp ships. */
const IG_WEB_APP_ID = '936619743392459';

const STORY_RE = /instagram\.com\/stories\/([^/?#]+)(?:\/(\d+))?/;
const POST_RE = /instagram\.com\/(?:[^/?#]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/;

export function isInstagramStoryUrl(url: string): boolean {
  return STORY_RE.test(url);
}

/** Instagram media ids are the shortcode base-64-decoded with this table
 *  (yt-dlp's _id_to_pk). Shortcodes longer than 28 chars carry a user-id
 *  prefix that must be dropped first. */
function shortcodeToPk(shortcode: string): string {
  const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const s = shortcode.length > 28 ? shortcode.slice(0, -28) : shortcode;
  let pk = 0n;
  for (const ch of s) {
    const v = TABLE.indexOf(ch);
    if (v < 0) throw new Error(`Unrecognized Instagram shortcode: ${shortcode}`);
    pk = pk * 64n + BigInt(v);
  }
  return pk.toString();
}

/** Fetch JSON with the session cookies + app-id headers Instagram's web
 *  API requires. `credentials: 'omit'` keeps React Native's WebView-backed
 *  cookie jar from overriding the manual Cookie header — cookies.txt (the
 *  same file yt-dlp reads) stays the single source of truth. */
async function igApiFetch(url: string): Promise<Record<string, unknown>> {
  const cookieHeader = await getCookieHeaderForDomain('instagram.com');
  if (!cookieHeader) throw new Error('No Instagram cookies on disk.');
  const csrf = await getCookieValue('instagram.com', 'csrftoken');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, {
      credentials: 'omit',
      headers: {
        'User-Agent': LOGIN_USER_AGENT,
        Accept: '*/*',
        Cookie: cookieHeader,
        Origin: 'https://www.instagram.com',
        Referer: 'https://www.instagram.com/',
        'X-IG-App-ID': IG_WEB_APP_ID,
        'X-ASBD-ID': '359341',
        'X-IG-WWW-Claim': '0',
        ...(csrf ? { 'X-CSRFToken': csrf } : {}),
      },
      signal: controller.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      throw new Error('Instagram rejected the saved login — sign in again under Credits.');
    }
    if (!resp.ok) {
      // Instagram's 4xx bodies name the actual refusal ("useragent
      // mismatch", "login_required", "checkpoint_required") — surface it,
      // a bare status code is undebuggable in the field.
      const body = await resp.text().catch(() => '');
      throw new Error(
        `Instagram API returned HTTP ${resp.status}${body ? `: ${body.slice(0, 200)}` : ''}`
      );
    }
    return (await resp.json()) as Record<string, unknown>;
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error('Instagram took too long to respond — check your connection and try again.');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve a username to Instagram's numeric user id.
 *
 * Ordered fallback chain — every single-endpoint approach has a live
 * failure mode:
 *  1. topsearch API — the web app's own username search; result is
 *     validated against the exact username, so it can never return a
 *     different account's id.
 *  2. media/<storyPk>/info — the pasted link carries the story item pk;
 *     its owner IS the account we want.
 *  3. web_profile_info — intermittently 400s with internal schema
 *     errors ("Asset ... has been deleted. You cannot use this schema").
 * (Parsing the story page HTML like yt-dlp does is deliberately NOT in
 * the chain: the React shell served to browser user-agents embeds no
 * reel data, and the objects it does embed include the logged-in
 * VIEWER's user JSON — a wrong-account footgun.)
 */
async function resolveUserId(username: string, storyId?: string): Promise<string> {
  // 1. topsearch — the web app's own search box endpoint.
  try {
    const data = await igApiFetch(
      `${API_BASE}/web/search/topsearch/?query=${encodeURIComponent(username)}`
    );
    const users = data.users as Array<Record<string, unknown>> | undefined;
    for (const row of users ?? []) {
      const u = row.user as Record<string, unknown> | undefined;
      if (
        typeof u?.username === 'string' &&
        u.username.toLowerCase() === username.toLowerCase()
      ) {
        const pk = u.pk ?? u.pk_id ?? u.id;
        if (pk !== undefined && /^\d+$/.test(String(pk))) return String(pk);
      }
    }
  } catch (e) {
    if (__DEV__) {
      console.log(
        '[instagramStories] topsearch failed:',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // 2. The story link's own item pk → media info → owner id.
  if (storyId) {
    try {
      const data = await igApiFetch(`${API_BASE}/media/${storyId}/info/`);
      const item = (data.items as Array<Record<string, unknown>> | undefined)?.[0];
      const pk = (item?.user as Record<string, unknown> | undefined)?.pk;
      if (pk !== undefined && /^\d+$/.test(String(pk))) return String(pk);
    } catch (e) {
      if (__DEV__) {
        console.log(
          '[instagramStories] media info failed:',
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  }

  // 3. web_profile_info API — last resort, known-flaky.
  const data = await igApiFetch(
    `${API_BASE}/users/web_profile_info/?username=${encodeURIComponent(username)}`
  );
  const user = (data.data as Record<string, unknown> | undefined)?.user as
    | Record<string, unknown>
    | undefined;
  const id = user?.id ?? user?.pk;
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error(`Could not resolve Instagram user "${username}".`);
  }
  return String(id);
}

type IgMediaVersion = { url?: string; width?: number; height?: number };

/** Largest variant wins — Instagram lists several encodes per item. */
function pickLargest(versions: unknown): IgMediaVersion | undefined {
  if (!Array.isArray(versions)) return undefined;
  let best: IgMediaVersion | undefined;
  let bestArea = -1;
  for (const v of versions as IgMediaVersion[]) {
    if (typeof v?.url !== 'string' || v.url.length === 0) continue;
    const area = (v.width ?? 0) * (v.height ?? 0);
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

/** Map one API media item (post, carousel child, or story item) to a
 *  direct-CDN DownloadEntry. Returns null when the item exposes no media. */
function entryFromItem(
  item: Record<string, unknown>,
  title: string,
  webpageUrl: string
): DownloadEntry | null {
  const pk = String(item.pk ?? item.id ?? '');
  const video = pickLargest(item.video_versions);
  const image = pickLargest(
    (item.image_versions2 as Record<string, unknown> | undefined)?.candidates
  );
  const media = video ?? image;
  if (!media?.url || !pk) return null;
  return {
    id: pk,
    title,
    thumbnail: image?.url,
    duration:
      typeof item.video_duration === 'number' ? (item.video_duration as number) : undefined,
    mediaType: video ? 'video' : 'image',
    webpageUrl,
    directUrl: media.url,
  };
}

/**
 * Probe an instagram.com/p|reel|tv/... POST through the cookied web API.
 *
 * Needed because a logged-in user skips the anonymous embed prober, and
 * cookied yt-dlp drops every IMAGE item of a post/carousel (its formats
 * come exclusively from video_versions) — a 4-photo carousel probes to
 * nothing. media/<pk>/info returns every child with photo + video CDN
 * URLs; entries download via downloadDirect without yt-dlp.
 */
export async function probeInstagramPost(url: string): Promise<ProbeResult> {
  const m = url.match(POST_RE);
  if (!m) throw new Error('Not a recognizable Instagram post URL.');
  const shortcode = m[1];
  const pk = shortcodeToPk(shortcode);

  const data = await igApiFetch(`${API_BASE}/media/${pk}/info/`);
  const item = (data.items as Array<Record<string, unknown>> | undefined)?.[0];
  if (!item) throw new Error('Instagram returned no media for this post.');

  const webpageUrl = `https://www.instagram.com/p/${shortcode}/`;
  const carousel = item.carousel_media as Array<Record<string, unknown>> | undefined;
  const children = Array.isArray(carousel) && carousel.length > 0 ? carousel : [item];

  const entries: DownloadEntry[] = [];
  children.forEach((child, i) => {
    // Per-child suffix keeps direct-download filenames unique — children
    // sharing one title would overwrite each other on disk.
    const title =
      children.length > 1
        ? `Instagram-${shortcode}-${i + 1}`
        : `Instagram-${shortcode}`;
    const entry = entryFromItem(child, title, webpageUrl);
    if (entry) entries.push(entry);
  });
  if (entries.length === 0) {
    throw new Error('No downloadable media found in this post.');
  }

  return { site: 'Instagram', isPlaylist: entries.length > 1, entries };
}

/**
 * Probe an instagram.com/stories/... URL (user stories or highlights)
 * through the cookied web API. Returns every item in the reel — the
 * story the pasted link points at plus its siblings — as direct-CDN
 * entries. Throws when the session is invalid or the reel is empty
 * (expired stories); the caller falls back to yt-dlp.
 */
export async function probeInstagramStory(url: string): Promise<ProbeResult> {
  const m = url.match(STORY_RE);
  if (!m) throw new Error('Not a recognizable Instagram story URL.');
  const [, username, storyId] = m;

  // Highlight links (/stories/highlights/<id>/) query the highlight reel
  // directly; user stories need the numeric user id first.
  const reelId =
    username === 'highlights'
      ? `highlight:${storyId}`
      : await resolveUserId(username, storyId);

  const data = await igApiFetch(
    `${API_BASE}/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`
  );
  const reelsMedia = data.reels_media;
  const reelsMap = data.reels as Record<string, unknown> | undefined;
  const reel =
    (Array.isArray(reelsMedia) ? (reelsMedia[0] as Record<string, unknown>) : undefined) ??
    (reelsMap?.[reelId] as Record<string, unknown> | undefined);
  const items = (reel?.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (items.length === 0) {
    throw new Error('This story has expired or has no items.');
  }

  // Chronological (taken_at ascending) so "item 1" in the app matches
  // "first story" on Instagram.
  const sorted = items
    .slice()
    .sort((a, b) => (Number(a.taken_at) || 0) - (Number(b.taken_at) || 0));

  const entries: DownloadEntry[] = [];
  for (const item of sorted) {
    const pk = String(item.pk ?? item.id ?? '');
    const entry = entryFromItem(
      item,
      `Instagram-story-${username}-${pk}`,
      `https://www.instagram.com/stories/${username}/${pk}/`
    );
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new Error('No downloadable media found in this story.');
  }

  return { site: 'Instagram', isPlaylist: entries.length > 1, entries };
}
