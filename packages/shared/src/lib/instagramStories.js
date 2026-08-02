/**
 * Cookied Instagram story + post probers.
 *
 * yt-dlp's instagram:story extractor builds formats exclusively from
 * `video_versions` and silently drops story items without them — i.e.
 * every PHOTO story item. A two-item story of [photo, video] probes as
 * just the video and the photo can never be downloaded. Stories always
 * require login anyway, so when Instagram cookies exist we skip yt-dlp
 * and call the same private web API it would use (feed/reels_media),
 * mapping EVERY item — photos included — to a direct CDN URL that the
 * direct-download path fetches without yt-dlp.
 *
 * Endpoints (mirrors yt-dlp's InstagramBaseIE in web-app mode):
 *   - /api/v1/users/web_profile_info/?username=X  → story owner's user id
 *   - /api/v1/feed/reels_media/?reel_ids=Y        → story/highlight items
 * Both need the X-IG-App-ID header plus the logged-in session cookies.
 *
 * All network goes through platform.httpRequest (a Rust reqwest command,
 * NO cookie jar) — the Cookie header is assembled explicitly from
 * cookies.txt, the same file yt-dlp reads, so "works in downloads" and
 * "works in the JS prober" can never disagree.
 */

import { getPlatform } from "../platform.js";
import { getCookieHeaderForDomain, getCookieValue } from "./cookies.js";
import { LOGIN_USER_AGENT } from "./loginPlatforms.js";

const API_BASE = "https://www.instagram.com/api/v1";
/** Instagram's public web-app id — same constant yt-dlp ships. */
const IG_WEB_APP_ID = "936619743392459";

const STORY_RE = /instagram\.com\/stories\/([^/?#]+)(?:\/(\d+))?/;
const POST_RE = /instagram\.com\/(?:[^/?#]+\/)?(?:p|reels?|tv)\/([A-Za-z0-9_-]+)/;

export function isInstagramStoryUrl(url) {
  return STORY_RE.test(url);
}

/** Path segments that are Instagram features, not usernames. */
const RESERVED_SEGMENTS = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct",
  "about", "developer", "legal", "directory", "lite", "challenge", "graphql",
  "api", "oauth", "emails", "session", "nametag", "invites",
]);

/**
 * A bare profile link (instagram.com/<username>) means "grab their active
 * stories". Returns the equivalent /stories/ URL, or null when the URL
 * isn't a plain profile path.
 */
export function instagramProfileToStoriesUrl(url) {
  // Host-anchored (start of string or right after //) so a lookalike host
  // or an instagram.com fragment buried in another URL's path can't
  // silently probe some unrelated account's stories.
  const m = url.match(/(?:^|\/\/)(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?(?:[?#]|$)/);
  if (!m) return null;
  const username = m[1];
  if (RESERVED_SEGMENTS.has(username.toLowerCase())) return null;
  return `https://www.instagram.com/stories/${username}/`;
}

/**
 * Is the saved Instagram session still accepted? Hits topsearch (the
 * cheapest authenticated endpoint the probers already rely on). Cached
 * for 15 minutes — Credits may ask on every expand.
 */
let sessionCheck = null;

/** Forget the cached verdict. MUST be called whenever the Instagram
 *  cookies change (fresh login, cookies.txt import, logout) — otherwise
 *  the "Session expired" badge outlives the re-login it demanded. */
export function invalidateInstagramSessionCache() {
  sessionCheck = null;
}

export async function checkInstagramSession() {
  if (sessionCheck && Date.now() - sessionCheck.at < 15 * 60 * 1000) {
    return sessionCheck.ok ? "ok" : "expired";
  }
  try {
    const data = await igApiFetch(`${API_BASE}/web/search/topsearch/?query=instagram`);
    // A live session returns result arrays; a dead one bounces to the
    // login wall (401/403 → igApiFetch throws) or an error payload.
    const ok = Array.isArray(data.users) || data.status === "ok";
    sessionCheck = { at: Date.now(), ok };
    return ok ? "ok" : "expired";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/rejected the saved login|HTTP 401|HTTP 403/.test(msg)) {
      sessionCheck = { at: Date.now(), ok: false };
      return "expired";
    }
    // Network trouble ≠ dead session — don't scare the user.
    return "unknown";
  }
}

/** Instagram media ids are the shortcode base-64-decoded with this table
 *  (yt-dlp's _id_to_pk). Shortcodes longer than 28 chars carry a user-id
 *  prefix that must be dropped first. BigInt is mandatory — the pk
 *  overflows a double and must never be float-ified. */
function shortcodeToPk(shortcode) {
  const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
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
 *  API requires. The Cookie header is built manually from cookies.txt —
 *  the reqwest side has no cookie jar, so cookies.txt (the same file
 *  yt-dlp reads) stays the single source of truth. The UA must be the
 *  registry LOGIN_USER_AGENT: cookies minted under it must probe under it. */
async function igApiFetch(url) {
  const platform = getPlatform();
  if (typeof platform.httpRequest !== "function") {
    throw new Error("URL probing requires the desktop app.");
  }
  const cookieHeader = await getCookieHeaderForDomain("instagram.com");
  if (!cookieHeader) throw new Error("No Instagram cookies on disk.");
  const csrf = await getCookieValue("instagram.com", "csrftoken");

  let resp;
  try {
    resp = await platform.httpRequest({
      url,
      method: "GET",
      headers: {
        "User-Agent": LOGIN_USER_AGENT,
        Accept: "*/*",
        Cookie: cookieHeader,
        Origin: "https://www.instagram.com",
        Referer: "https://www.instagram.com/",
        "X-IG-App-ID": IG_WEB_APP_ID,
        "X-ASBD-ID": "359341",
        "X-IG-WWW-Claim": "0",
        ...(csrf ? { "X-CSRFToken": csrf } : {}),
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

  if (resp.status === 401 || resp.status === 403) {
    throw new Error("Instagram rejected the saved login — sign in again under Credits.");
  }
  if (resp.status < 200 || resp.status >= 300) {
    // Instagram's 4xx bodies name the actual refusal ("useragent
    // mismatch", "login_required", "checkpoint_required") — surface it,
    // a bare status code is undebuggable in the field.
    const body = typeof resp.body === "string" ? resp.body : "";
    throw new Error(
      `Instagram API returned HTTP ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
  }
  try {
    return JSON.parse(resp.body);
  } catch {
    throw new Error("Instagram returned an unreadable response.");
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
async function resolveUserId(username, storyId) {
  // 1. topsearch — the web app's own search box endpoint.
  try {
    const data = await igApiFetch(
      `${API_BASE}/web/search/topsearch/?query=${encodeURIComponent(username)}`
    );
    const users = data.users;
    for (const row of Array.isArray(users) ? users : []) {
      const u = row?.user;
      if (typeof u?.username === "string" && u.username.toLowerCase() === username.toLowerCase()) {
        const pk = u.pk ?? u.pk_id ?? u.id;
        if (pk !== undefined && /^\d+$/.test(String(pk))) return String(pk);
      }
    }
  } catch {
    // Fall through to the next resolver.
  }

  // 2. The story link's own item pk → media info → owner id.
  if (storyId) {
    try {
      const data = await igApiFetch(`${API_BASE}/media/${storyId}/info/`);
      const item = Array.isArray(data.items) ? data.items[0] : undefined;
      const pk = item?.user?.pk;
      if (pk !== undefined && /^\d+$/.test(String(pk))) return String(pk);
    } catch {
      // Fall through to the next resolver.
    }
  }

  // 3. web_profile_info API — last resort, known-flaky.
  const data = await igApiFetch(
    `${API_BASE}/users/web_profile_info/?username=${encodeURIComponent(username)}`
  );
  const user = data.data?.user;
  const id = user?.id ?? user?.pk;
  if (id === undefined || id === null || String(id).length === 0) {
    throw new Error(`Could not resolve Instagram user "${username}".`);
  }
  return String(id);
}

/** Largest variant wins — Instagram lists several encodes per item. */
function pickLargest(versions) {
  if (!Array.isArray(versions)) return undefined;
  let best;
  let bestArea = -1;
  for (const v of versions) {
    if (typeof v?.url !== "string" || v.url.length === 0) continue;
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
function entryFromItem(item, title, webpageUrl, sourceUrl) {
  const pk = String(item.pk ?? item.id ?? "");
  const video = pickLargest(item.video_versions);
  const image = pickLargest(item.image_versions2?.candidates);
  const media = video ?? image;
  if (!media?.url || !pk) return null;
  // Expose every video encode so the download step can honor the user's
  // quality cap instead of always taking the largest.
  const variants = video
    ? item.video_versions
        .filter((v) => typeof v?.url === "string" && v.url.length > 0)
        .map((v) => ({ url: v.url, width: v.width, height: v.height }))
    : null;
  const uploader = typeof item.user?.username === "string" ? item.user.username : null;
  return {
    id: pk,
    title,
    url: webpageUrl,
    sourceUrl,
    playlistIndex: null,
    mediaType: video ? "video" : "image",
    thumbnail: image?.url ?? null,
    directUrl: media.url,
    variants: variants && variants.length > 0 ? variants : null,
    duration: typeof item.video_duration === "number" ? item.video_duration : null,
    uploader,
    partialCarousel: false,
  };
}

/**
 * Probe an instagram.com/p|reel|tv/... POST through the cookied web API.
 *
 * Needed because a logged-in user skips the anonymous embed prober, and
 * cookied yt-dlp drops every IMAGE item of a post/carousel (its formats
 * come exclusively from video_versions) — a 4-photo carousel probes to
 * nothing. media/<pk>/info returns every child with photo + video CDN
 * URLs; entries download via the direct lane without yt-dlp.
 */
export async function probeInstagramPost(url) {
  const m = url.match(POST_RE);
  if (!m) throw new Error("Not a recognizable Instagram post URL.");
  const shortcode = m[1];
  const pk = shortcodeToPk(shortcode);

  const data = await igApiFetch(`${API_BASE}/media/${pk}/info/`);
  const item = Array.isArray(data.items) ? data.items[0] : undefined;
  if (!item) throw new Error("Instagram returned no media for this post.");

  const webpageUrl = `https://www.instagram.com/p/${shortcode}/`;
  const carousel = item.carousel_media;
  const children = Array.isArray(carousel) && carousel.length > 0 ? carousel : [item];

  const entries = [];
  children.forEach((child, i) => {
    // Per-child suffix keeps direct-download filenames unique — children
    // sharing one title would overwrite each other on disk.
    const title =
      children.length > 1 ? `Instagram-${shortcode}-${i + 1}` : `Instagram-${shortcode}`;
    const entry = entryFromItem(child, title, webpageUrl, url);
    if (entry) entries.push(entry);
  });
  if (entries.length === 0) {
    throw new Error("No downloadable media found in this post.");
  }

  return { site: "Instagram", isPlaylist: entries.length > 1, entries };
}

/**
 * Probe an instagram.com/stories/... URL (user stories or highlights)
 * through the cookied web API. Returns every item in the reel — the
 * story the pasted link points at plus its siblings — as direct-CDN
 * entries. Throws when the session is invalid or the reel is empty
 * (expired stories); the caller falls back to yt-dlp.
 */
export async function probeInstagramStory(url) {
  const m = url.match(STORY_RE);
  if (!m) throw new Error("Not a recognizable Instagram story URL.");
  const [, username, storyId] = m;

  // Highlight links (/stories/highlights/<id>/) query the highlight reel
  // directly; user stories need the numeric user id first.
  const reelId =
    username === "highlights" ? `highlight:${storyId}` : await resolveUserId(username, storyId);

  const data = await igApiFetch(
    `${API_BASE}/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`
  );
  // Both response shapes: reels_media array (newer) and reels map keyed
  // by reel id (older).
  const reelsMedia = data.reels_media;
  const reelsMap = data.reels;
  const reel =
    (Array.isArray(reelsMedia) ? reelsMedia[0] : undefined) ??
    (reelsMap && typeof reelsMap === "object" ? reelsMap[reelId] : undefined);
  const items = Array.isArray(reel?.items) ? reel.items : [];
  if (items.length === 0) {
    throw new Error("This story has expired or has no items.");
  }

  // Chronological (taken_at ascending) so "item 1" in the app matches
  // "first story" on Instagram.
  const sorted = items.slice().sort((a, b) => (Number(a.taken_at) || 0) - (Number(b.taken_at) || 0));

  const entries = [];
  for (const item of sorted) {
    const pk = String(item.pk ?? item.id ?? "");
    const entry = entryFromItem(
      item,
      `Instagram-story-${username}-${pk}`,
      `https://www.instagram.com/stories/${username}/${pk}/`,
      url
    );
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new Error("No downloadable media found in this story.");
  }

  return { site: "Instagram", isPlaylist: entries.length > 1, entries };
}
