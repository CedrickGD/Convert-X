/**
 * Instagram post + story probers (cookied web API and logged-out GraphQL).
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
 *   - /api/v1/media/<pk>/info/                    → post + carousel children
 *   - /api/graphql (PolarisLoggedOutDesktopWWWPostRootContentQuery)
 *                                                 → public posts, no login
 * All need the X-IG-App-ID header; the first three the session cookies.
 *
 * Every request goes through instagramNet.igRequest — a hidden WebView
 * (real Chromium) — because Instagram refuses non-browser TLS clients
 * even with a valid session. See that module for the full story.
 */

import type { DownloadEntry, ProbeResult } from './downloadQueue';
import { getCookieValue } from './cookies';
import { logError } from './errorLog';
import {
  IG_ORIGIN,
  igRequest,
  instagramTransportEpoch,
  parseCookieJar,
  type IgRequestMode,
  type IgResponse,
} from './instagramNet';

const API_BASE = `${IG_ORIGIN}/api/v1`;
/** Instagram's public web-app id — same constant yt-dlp ships. */
const IG_WEB_APP_ID = '936619743392459';
/** Persisted GraphQL query id of the logged-out post page (yt-dlp master,
 *  Oct 2026). Rotates rarely; when it does, the embed and yt-dlp
 *  fallbacks in downloadQueue still cover public posts. */
const LOGGED_OUT_POST_DOC_ID = '27130156389949648';
const LOGGED_OUT_POST_QUERY = 'PolarisLoggedOutDesktopWWWPostRootContentQuery';
/** Logged-in story query the Instagram web app runs for /stories/… — the
 *  REST /api/v1/feed/reels_media endpoint is now soft-blocked for web
 *  sessions (returns a generic error / login wall even when the session
 *  is valid), so stories go through this GraphQL query instead. doc_id
 *  from the logged-in story-page JS bundle (Oct 2026); rotates rarely,
 *  and the REST path stays as a fallback. */
const STORY_DOC_ID = '29170422829314651';
const STORY_QUERY = 'PolarisStoriesV3ReelPageStandaloneQuery';
/** The web app's GraphQL user search (the REST /web/search/topsearch it
 *  wraps is soft-blocked). Resolves a username to the numeric user id the
 *  story query needs in reel_ids_arr. */
const TOPSEARCH_DOC_ID = '40560838120170065';
const TOPSEARCH_QUERY = 'PolarisAPITopsearchQuery';
/** Logged-in post query the web app runs for /p/<shortcode>/ (root field
 *  xdt_api__v1__media__shortcode__web_info — the GraphQL twin of the
 *  soft-blocked REST media/<pk>/info, same item shape incl. carousels). */
const POST_DOC_ID = '28796617543330760';
const POST_QUERY = 'PolarisPostRootQuery';

const STORY_RE = /instagram\.com\/stories\/([^/?#]+)(?:\/(\d+))?/;
// Same constraints as yt-dlp's InstagramIE: a `share/…` prefix is a
// share-sheet redirect (no shortcode in it), `reels/audio/…` is an audio
// page — neither is a post.
const POST_RE = /instagram\.com\/(?:(?!share\/)[^/?#]+\/)?(?:p|tv|reels?(?!\/audio\/))\/([A-Za-z0-9_-]+)/;
const SHARE_RE = /^https?:\/\/(?:www\.)?instagram\.com\/share\/[^?#]+/i;

export function isInstagramStoryUrl(url: string): boolean {
  return STORY_RE.test(url);
}

/** Path segments that are Instagram features, not usernames. */
const RESERVED_SEGMENTS = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'direct',
  'about', 'developer', 'legal', 'directory', 'lite', 'challenge', 'graphql',
  'api', 'oauth', 'emails', 'session', 'nametag', 'invites',
]);

/**
 * A bare profile link (instagram.com/<username>) means "grab their active
 * stories". Returns the equivalent /stories/ URL, or null when the URL
 * isn't a plain profile path.
 */
export function instagramProfileToStoriesUrl(url: string): string | null {
  // Host-anchored (start of string or right after //) so a lookalike host
  // or an instagram.com fragment buried in another URL's path can't
  // silently probe some unrelated account's stories.
  const m = url.match(
    /(?:^|\/\/)(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)\/?(?:[?#]|$)/
  );
  if (!m) return null;
  const username = m[1];
  if (RESERVED_SEGMENTS.has(username.toLowerCase())) return null;
  return `https://www.instagram.com/stories/${username}/`;
}

// ── Errors ──────────────────────────────────────────────────────────────

export type InstagramErrorKind =
  /** The saved session is no longer accepted — re-login fixes it. */
  | 'expired'
  /** Instagram wants the account owner to pass a checkpoint/challenge in
   *  the real app before the session works again. */
  | 'checkpoint'
  /** Content needs a login we don't have (private, age-gated). */
  | 'login_required'
  /** Instagram throttled this device/IP. */
  | 'rate_limited'
  /** The post/story does not exist (or was removed). */
  | 'not_found'
  /** Anything else — network, parse, unexpected shape. */
  | 'other';

export class InstagramError extends Error {
  kind: InstagramErrorKind;
  constructor(kind: InstagramErrorKind, message: string) {
    super(message);
    this.name = 'InstagramError';
    this.kind = kind;
  }
}

export function instagramErrorKind(e: unknown): InstagramErrorKind | null {
  return e instanceof InstagramError ? e.kind : null;
}

const MESSAGES: Record<Exclude<InstagramErrorKind, 'other'>, string> = {
  expired:
    'Your Instagram login has expired — sign in again under Credits → Platform logins.',
  checkpoint:
    "Instagram wants you to confirm it's you — open the Instagram app, complete the check, then sign in again under Credits.",
  login_required:
    'This Instagram content needs a login — connect Instagram under Credits → Platform logins.',
  rate_limited:
    'Instagram is rate-limiting this device — wait a few minutes and try again.',
  not_found: 'This Instagram post does not exist or was removed.',
};

export function instagramMessage(kind: Exclude<InstagramErrorKind, 'other'>): string {
  return MESSAGES[kind];
}

// ── Transport helpers ───────────────────────────────────────────────────

const API_HEADERS: Record<string, string> = {
  'X-IG-App-ID': IG_WEB_APP_ID,
  'X-ASBD-ID': '359341',
  'X-IG-WWW-Claim': '0',
  Accept: '*/*',
};

function isLoginWall(resp: IgResponse): boolean {
  const path = (() => {
    try {
      return new URL(resp.url).pathname;
    } catch {
      return resp.url;
    }
  })();
  return (
    path.startsWith('/accounts/login') ||
    path.startsWith('/challenge') ||
    path.startsWith('/accounts/suspended')
  );
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<');
}

/** Map Instagram's JSON refusals (`{"message": "..."}`) to error kinds. */
function classifyApiMessage(message: string | undefined, loggedIn: boolean): InstagramErrorKind | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes('checkpoint') || m.includes('challenge')) return 'checkpoint';
  if (m.includes('login_required') || m.includes('login required') || m.includes('not logged in')) {
    return loggedIn ? 'expired' : 'login_required';
  }
  if (m.includes('feedback_required') || m.includes('rate limit') || m.includes('please wait')) {
    return 'rate_limited';
  }
  if (m.includes('media not found') || m.includes('cannot be found') || m.includes('not found')) {
    return 'not_found';
  }
  if (m.includes('useragent mismatch')) return loggedIn ? 'expired' : 'other';
  return null;
}

/**
 * Fetch a JSON API endpoint. Throws InstagramError with a classified kind
 * for every refusal shape Instagram uses: HTTP 401/403, a redirect to the
 * login wall, an HTML page where JSON was asked for (the "bot" treatment
 * and the login wall both look like that), or a JSON error payload.
 */
async function igApiJson(
  url: string,
  mode: IgRequestMode,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; referrer?: string } = {}
): Promise<Record<string, unknown>> {
  const loggedIn = mode === 'session';
  let resp: IgResponse;
  try {
    resp = await igRequest(url, {
      mode,
      method: init.method ?? 'GET',
      headers: { ...API_HEADERS, ...(init.headers ?? {}) },
      body: init.body,
      referrer: init.referrer ?? `${IG_ORIGIN}/`,
      timeoutMs: 20000,
    });
  } catch (e) {
    if (e instanceof InstagramError) throw e;
    throw new InstagramError('other', e instanceof Error ? e.message : String(e));
  }

  if (isLoginWall(resp)) {
    throw new InstagramError(loggedIn ? 'expired' : 'login_required', instagramMessage(loggedIn ? 'expired' : 'login_required'));
  }
  if (resp.status === 401 || resp.status === 403) {
    const viaBody = tryParseJson(resp.body);
    const kind =
      classifyApiMessage(typeof viaBody?.message === 'string' ? viaBody.message : undefined, loggedIn) ??
      (loggedIn ? 'expired' : 'login_required');
    throw new InstagramError(
      kind,
      kind === 'other'
        ? `Instagram refused the request (HTTP ${resp.status})`
        : instagramMessage(kind)
    );
  }
  if (resp.status === 429) {
    throw new InstagramError('rate_limited', instagramMessage('rate_limited'));
  }
  if (resp.status === 404) {
    throw new InstagramError('not_found', instagramMessage('not_found'));
  }
  const data = tryParseJson(resp.body);
  if (!data) {
    if (looksLikeHtml(resp.body)) {
      // JSON was requested, a page came back: Instagram either bounced us
      // to the (unredirected) login wall or decided we are a bot.
      const kind: InstagramErrorKind = loggedIn ? 'expired' : 'login_required';
      throw new InstagramError(kind, instagramMessage(kind));
    }
    throw new InstagramError(
      'other',
      `Instagram API returned HTTP ${resp.status} with an unreadable body${resp.body ? `: ${resp.body.slice(0, 120)}` : ''}`
    );
  }
  const message = typeof data.message === 'string' ? data.message : undefined;
  const status = typeof data.status === 'string' ? data.status : undefined;
  if (status === 'fail' || !resp.status || resp.status >= 400) {
    const kind = classifyApiMessage(message, loggedIn) ?? 'other';
    throw new InstagramError(
      kind,
      kind === 'other'
        ? `Instagram API refused the request${message ? `: ${message}` : ` (HTTP ${resp.status})`}`
        : instagramMessage(kind)
    );
  }
  return data;
}

function tryParseJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const v = JSON.parse(trimmed) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Logged-in JSON call (cookies.txt session). */
function igApiFetch(url: string): Promise<Record<string, unknown>> {
  return igApiJson(url, 'session');
}

// ── Session health ──────────────────────────────────────────────────────

/**
 * Is the saved Instagram session still accepted? Hits topsearch (the
 * cheapest authenticated endpoint the probers already rely on). Cached
 * for 15 minutes — Credits may ask on every expand.
 */
let sessionCheck: { at: number; ok: boolean } | null = null;

/** Forget the cached verdict. MUST be called whenever the Instagram
 *  cookies change (fresh login, cookies.txt import, logout) — otherwise
 *  the "Session expired" badge outlives the re-login it demanded. */
export function invalidateInstagramSessionCache(): void {
  sessionCheck = null;
}

export async function checkInstagramSession(): Promise<'ok' | 'expired' | 'unknown'> {
  if (sessionCheck && Date.now() - sessionCheck.at < 15 * 60 * 1000) {
    return sessionCheck.ok ? 'ok' : 'expired';
  }
  try {
    const data = await igApiFetch(`${API_BASE}/web/search/topsearch/?query=instagram`);
    // A live session returns result arrays; a dead one bounces to the
    // login wall (→ igApiJson throws) or an error payload.
    const ok = Array.isArray(data.users) || data.status === 'ok';
    sessionCheck = { at: Date.now(), ok };
    return ok ? 'ok' : 'expired';
  } catch (e) {
    const kind = instagramErrorKind(e);
    if (kind === 'expired' || kind === 'checkpoint' || kind === 'login_required') {
      sessionCheck = { at: Date.now(), ok: false };
      return 'expired';
    }
    // Network trouble ≠ dead session — don't scare the user.
    return 'unknown';
  }
}

// ── Shortcode / id helpers ──────────────────────────────────────────────

/** Instagram media ids are the shortcode base-64-decoded with this table
 *  (yt-dlp's _id_to_pk). Shortcodes longer than 28 chars carry a user-id
 *  prefix that must be dropped first. */
export function shortcodeToPk(shortcode: string): string {
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

export function instagramPostShortcode(url: string): string | null {
  const m = url.match(POST_RE);
  return m ? m[1] : null;
}

/** instagram.com/share/<kind>/<token> — the share sheet's opaque link
 *  that redirects to the real post. */
export function isInstagramShareUrl(url: string): boolean {
  return SHARE_RE.test(url.trim());
}

/**
 * Follow a share link to the post it points at (through the browser
 * bridge, anonymously). Returns the canonical post URL, or null when the
 * redirect didn't land on a post.
 */
export async function resolveInstagramShareUrl(url: string): Promise<string | null> {
  const resp = await igRequest(url.trim(), {
    mode: 'anonymous',
    headers: { Accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 15000,
  });
  const final = resp.url || '';
  return instagramPostShortcode(final) ? final.split('?')[0] : null;
}

// ── User id resolution (stories) ────────────────────────────────────────

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
  let authError: InstagramError | null = null;
  const remember = (e: unknown) => {
    const kind = instagramErrorKind(e);
    if (!authError && (kind === 'expired' || kind === 'checkpoint' || kind === 'login_required')) {
      authError = e as InstagramError;
    }
  };

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
    remember(e);
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
      remember(e);
      if (__DEV__) {
        console.log(
          '[instagramStories] media info failed:',
          e instanceof Error ? e.message : String(e)
        );
      }
    }
  }

  // 3. web_profile_info API — last resort, known-flaky.
  try {
    const data = await igApiFetch(
      `${API_BASE}/users/web_profile_info/?username=${encodeURIComponent(username)}`
    );
    const user = (data.data as Record<string, unknown> | undefined)?.user as
      | Record<string, unknown>
      | undefined;
    const id = user?.id ?? user?.pk;
    if (id !== undefined && id !== null && String(id).length > 0) return String(id);
  } catch (e) {
    remember(e);
  }
  // Three endpoints refusing in the same way is an auth problem, not a
  // username problem — say so, or the user re-types a correct handle.
  if (authError) throw authError;
  throw new Error(`Could not resolve Instagram user "${username}".`);
}

// ── Media item → entry ──────────────────────────────────────────────────

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
 *  direct-CDN DownloadEntry. Returns null when the item exposes no media.
 *  The shape is shared by media/info, reels_media AND the logged-out
 *  GraphQL product (`video_versions`, `image_versions2.candidates`). */
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
  // Expose every video encode so the download step can honor the user's
  // quality cap instead of always taking the largest.
  const variants = video
    ? (item.video_versions as IgMediaVersion[])
        .filter((v) => typeof v?.url === 'string' && v.url.length > 0)
        .map((v) => ({ url: v.url as string, width: v.width, height: v.height }))
    : undefined;
  return {
    id: pk,
    title,
    thumbnail: image?.url,
    duration:
      typeof item.video_duration === 'number' ? (item.video_duration as number) : undefined,
    mediaType: video ? 'video' : 'image',
    webpageUrl,
    directUrl: media.url,
    variants,
  };
}

/** Turn a post product (single item or carousel parent) into entries. */
function entriesFromProduct(product: Record<string, unknown>, shortcode: string): DownloadEntry[] {
  const webpageUrl = `https://www.instagram.com/p/${shortcode}/`;
  const carousel = product.carousel_media as Array<Record<string, unknown>> | undefined;
  const children = Array.isArray(carousel) && carousel.length > 0 ? carousel : [product];
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
  return entries;
}

// ── Posts ───────────────────────────────────────────────────────────────

/**
 * Probe an instagram.com/p|reel|tv/... POST through the cookied web API.
 *
 * Needed because a logged-in user skips the anonymous probers, and
 * cookied yt-dlp drops every IMAGE item of a post/carousel (its formats
 * come exclusively from video_versions) — a 4-photo carousel probes to
 * nothing. media/<pk>/info returns every child with photo + video CDN
 * URLs; entries download via downloadDirect without yt-dlp.
 */
export async function probeInstagramPost(url: string): Promise<ProbeResult> {
  const shortcode = instagramPostShortcode(url);
  if (!shortcode) throw new Error('Not a recognizable Instagram post URL.');

  // Primary: the web app's own logged-in post query. Session-level
  // refusals and a definitive "not visible to you" answer are final.
  let graphqlError: unknown = null;
  try {
    return await probeInstagramPostGraphql(shortcode);
  } catch (e) {
    const kind = instagramErrorKind(e);
    if (kind === 'expired' || kind === 'checkpoint' || kind === 'rate_limited' || kind === 'not_found') {
      throw e;
    }
    graphqlError = e;
    logError('probe', e, `instagram post graphql: ${url}`);
  }

  // Legacy REST — soft-blocked for web sessions since Oct 2026, kept in
  // case Instagram re-opens it.
  try {
    const pk = shortcodeToPk(shortcode);
    const data = await igApiFetch(`${API_BASE}/media/${pk}/info/`);
    const item = (data.items as Array<Record<string, unknown>> | undefined)?.[0];
    if (!item) throw new InstagramError('not_found', 'Instagram returned no media for this post.');
    const entries = entriesFromProduct(item, shortcode);
    if (entries.length === 0) {
      throw new Error('No downloadable media found in this post.');
    }
    return { site: 'Instagram', isPlaylist: entries.length > 1, entries };
  } catch (e) {
    if (instagramErrorKind(e) === 'checkpoint') throw e;
    // The dead REST endpoint dresses its refusal up as "login expired";
    // when GraphQL already ran, its error is the honest one.
    throw graphqlError ?? e;
  }
}

/**
 * A post through the web app's logged-in GraphQL query (PolarisPostRoot-
 * Query): every carousel child with photo + video CDN URLs, for public
 * posts and for private posts the account is allowed to see.
 */
async function probeInstagramPostGraphql(shortcode: string): Promise<ProbeResult> {
  const data = await igGraphqlSession(
    POST_DOC_ID,
    POST_QUERY,
    {
      shortcode,
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
      __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
      __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false,
    },
    `${IG_ORIGIN}/p/${shortcode}/`
  );
  const payload = data.data as Record<string, unknown> | null | undefined;
  const root = payload?.xdt_api__v1__media__shortcode__web_info as
    | Record<string, unknown>
    | null
    | undefined;
  const items = Array.isArray(root?.items) ? (root?.items as Array<Record<string, unknown>>) : [];
  const item = items[0];
  if (item) {
    const entries = entriesFromProduct(item, shortcode);
    if (entries.length === 0) throw new Error('No downloadable media found in this post.');
    return { site: 'Instagram', isPlaylist: entries.length > 1, entries };
  }
  const err = firstGraphqlError(data);
  if (payload && root !== undefined && !err) {
    // A clean answer with no media: Instagram will not show this post to
    // this account — a private account it doesn't follow, or removed.
    throw new InstagramError(
      'not_found',
      "Instagram doesn't show this post to your account — it's from a private account you don't follow, or it was removed."
    );
  }
  throw new InstagramError(
    'other',
    `Instagram did not return this post${err ? ` (GraphQL: ${err})` : ''} — it may be private or removed.`
  );
}

/** LSD token + csrf from an anonymous page load, cached briefly — one
 *  homepage fetch per probe is plenty and Instagram notices hammering. */
/** Pull the LSD token out of an Instagram page's HTML. */
function extractLsd(html: string): string | undefined {
  let lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
  if (!lsd) {
    const eqmc = html.match(/<script\b[^>]*\bid="__eqmc"[^>]*>(\{[\s\S]*?\})<\/script>/)?.[1];
    if (eqmc) {
      try {
        const parsed = JSON.parse(eqmc) as { l?: unknown };
        if (typeof parsed.l === 'string') lsd = parsed.l;
      } catch {
        // fall through
      }
    }
  }
  return lsd;
}

let anonTokens: { at: number; epoch: number; lsd: string } | null = null;

async function anonymousLsdToken(): Promise<string> {
  if (
    anonTokens &&
    anonTokens.epoch === instagramTransportEpoch() &&
    Date.now() - anonTokens.at < 10 * 60 * 1000
  ) {
    return anonTokens.lsd;
  }
  const resp = await igRequest(`${IG_ORIGIN}/`, {
    mode: 'anonymous',
    headers: { Accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 20000,
  });
  const lsd = extractLsd(resp.body);
  if (!lsd) {
    throw new InstagramError('other', 'Instagram did not hand out a session token for anonymous access.');
  }
  anonTokens = { at: Date.now(), epoch: instagramTransportEpoch(), lsd };
  return lsd;
}

/** Tokens a logged-in GraphQL POST needs: lsd + fb_dtsg (the web app's
 *  authenticated form token), scraped from the logged-in homepage. */
let sessionGqlTokens: { at: number; epoch: number; lsd: string; dtsg?: string } | null = null;

async function sessionGraphqlTokens(): Promise<{ lsd: string; dtsg?: string }> {
  if (
    sessionGqlTokens &&
    sessionGqlTokens.epoch === instagramTransportEpoch() &&
    Date.now() - sessionGqlTokens.at < 10 * 60 * 1000
  ) {
    return sessionGqlTokens;
  }
  const resp = await igRequest(`${IG_ORIGIN}/`, {
    mode: 'session',
    headers: { Accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 20000,
  });
  const html = resp.body;
  const lsd = extractLsd(html);
  if (!lsd) {
    throw new InstagramError('expired', instagramMessage('expired'));
  }
  const dtsg =
    html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/)?.[1] ??
    html.match(/\["DTSGInitData",\[\],\{"token":"([^"]+)"/)?.[1] ??
    html.match(/"dtsg":\s*\{"token":"([^"]+)"/)?.[1];
  sessionGqlTokens = { at: Date.now(), epoch: instagramTransportEpoch(), lsd, dtsg };
  return sessionGqlTokens;
}

function jazoestFor(token: string): string {
  let sum = 0;
  for (let i = 0; i < token.length; i += 1) sum += token.charCodeAt(i);
  return `2${sum}`;
}

/** A random id in the shape Instagram's web search uses for its
 *  rank_token / search_session_id (any unique string is accepted). */
function randomToken(): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    out += hex[Math.floor(Math.random() * 16)];
    if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
  }
  return out;
}

/**
 * POST one logged-in GraphQL query through the bridge with the same form
 * the Instagram web app sends (session cookies + fb_dtsg + lsd + csrf).
 * Returns the parsed JSON; GraphQL-level `errors` are NOT thrown here —
 * Instagram routinely returns a partial `field_exception` next to valid
 * data, so callers decide from the data they actually got.
 */
async function igGraphqlSession(
  docId: string,
  friendlyName: string,
  variables: Record<string, unknown>,
  referrer: string
): Promise<Record<string, unknown>> {
  const { lsd, dtsg } = await sessionGraphqlTokens();
  const csrf = await getCookieValue('instagram.com', 'csrftoken');
  const dsUser = await getCookieValue('instagram.com', 'ds_user_id');

  const form = new URLSearchParams();
  if (dsUser) form.set('av', dsUser);
  form.set('__comet_req', '7');
  if (dtsg) {
    form.set('fb_dtsg', dtsg);
    form.set('jazoest', jazoestFor(dtsg));
  }
  form.set('lsd', lsd);
  form.set('fb_api_caller_class', 'RelayModern');
  form.set('fb_api_req_friendly_name', friendlyName);
  form.set('variables', JSON.stringify(variables));
  form.set('server_timestamps', 'true');
  form.set('doc_id', docId);

  const headers: Record<string, string> = {
    'X-FB-Friendly-Name': friendlyName,
    'X-FB-LSD': lsd,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (csrf) headers['X-CSRFToken'] = csrf;

  return igApiJson(`${IG_ORIGIN}/api/graphql`, 'session', {
    method: 'POST',
    headers,
    body: form.toString(),
    referrer,
  });
}

function firstGraphqlError(data: Record<string, unknown>): string {
  const errors = Array.isArray(data.errors) ? (data.errors as Array<Record<string, unknown>>) : [];
  return typeof errors[0]?.message === 'string' ? (errors[0].message as string).slice(0, 160) : '';
}

/**
 * Username → numeric user id through the web app's GraphQL search. The
 * result is matched against the exact username, so it can never return a
 * different account's id (search ranks look-alikes too).
 */
async function resolveUserIdGraphql(username: string): Promise<string> {
  const data = await igGraphqlSession(
    TOPSEARCH_DOC_ID,
    TOPSEARCH_QUERY,
    {
      data: {
        context: 'blended',
        include_reel: 'true',
        query: username,
        rank_token: randomToken(),
        search_session_id: randomToken(),
        search_surface: 'web_top_search',
      },
    },
    `${IG_ORIGIN}/`
  );
  const conn = (data.data as Record<string, unknown> | undefined)
    ?.xdt_api__v1__fbsearch__topsearch_connection as Record<string, unknown> | undefined;
  const rows = (conn?.users as Array<Record<string, unknown>> | undefined) ?? [];
  const wanted = username.toLowerCase();
  for (const row of rows) {
    const u = ((row.user as Record<string, unknown> | undefined) ?? row) as Record<string, unknown>;
    if (typeof u.username === 'string' && u.username.toLowerCase() === wanted) {
      const pk = u.pk ?? u.pk_id ?? u.id;
      if (pk !== undefined && /^\d+$/.test(String(pk))) return String(pk);
    }
  }
  const err = firstGraphqlError(data);
  throw new InstagramError(
    'other',
    `Instagram user search did not find "${username}"${err ? ` (${err})` : ` (${rows.length} results)`}`
  );
}

/**
 * Probe a story through the web app's own GraphQL query — exactly what
 * instagram.com runs for /stories/<user>/<item>/: PolarisStoriesV3Reel-
 * PageStandaloneQuery with {media_id, reel_ids_arr: [ownerId]}. The owner
 * id comes from the GraphQL user search (its REST twin is soft-blocked).
 * Returns every reel item (photos + videos) as a direct-CDN entry; throws
 * an InstagramError on refusal so the caller can fall back.
 */
async function probeInstagramStoryGraphql(
  username: string,
  storyId: string | undefined
): Promise<ProbeResult> {
  const isHighlight = username === 'highlights';
  if (isHighlight && !storyId) {
    throw new InstagramError('not_found', 'This highlight link is missing its id.');
  }

  let reelIds: string[];
  if (isHighlight) {
    reelIds = [`highlight:${storyId}`];
  } else {
    let ownerId: string;
    try {
      ownerId = await resolveUserIdGraphql(username);
    } catch (e) {
      // Session-level refusals are final; anything else gets the legacy
      // REST lookup chain as a second chance.
      const kind = instagramErrorKind(e);
      if (kind === 'expired' || kind === 'checkpoint' || kind === 'rate_limited') throw e;
      logError('probe', e, `instagram user search: ${username}`);
      ownerId = await resolveUserId(username, storyId);
    }
    reelIds = [ownerId];
  }

  const variables: Record<string, unknown> = {
    reel_ids_arr: reelIds,
    media_id: isHighlight ? null : storyId ?? null,
    is_highlight: isHighlight,
    __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: false,
  };
  const referrer = isHighlight
    ? `${IG_ORIGIN}/stories/highlights/${storyId}/`
    : `${IG_ORIGIN}/stories/${username}/${storyId ? `${storyId}/` : ''}`;

  const readItems = (d: Record<string, unknown>) => {
    const root = (d.data as Record<string, unknown> | undefined)
      ?.xdt_api__v1__feed__reels_media as Record<string, unknown> | undefined;
    const rs = root?.reels_media as Array<Record<string, unknown>> | undefined;
    const r = Array.isArray(rs) ? rs[0] : undefined;
    return {
      reels: rs,
      items: (r?.items as Array<Record<string, unknown>> | undefined) ?? [],
    };
  };

  let data = await igGraphqlSession(STORY_DOC_ID, STORY_QUERY, variables, referrer);
  let { reels, items } = readItems(data);
  if (items.length === 0 && variables.media_id) {
    // The deep-link form occasionally trips a server field_exception;
    // the whole reel by owner id alone is the same set of items.
    logError(
      'probe',
      new Error(`story graphql with media_id empty: ${firstGraphqlError(data) || 'no error'}`),
      `${username}/${storyId}`
    );
    data = await igGraphqlSession(
      STORY_DOC_ID,
      STORY_QUERY,
      { ...variables, media_id: null },
      referrer
    );
    ({ reels, items } = readItems(data));
  }
  if (items.length === 0) {
    const err = firstGraphqlError(data);
    const shape = data.data && typeof data.data === 'object'
      ? Object.keys(data.data as Record<string, unknown>).join(',')
      : 'no data';
    throw new InstagramError(
      'other',
      `Instagram stories GraphQL returned no items${err ? `: ${err}` : ''} [data: ${shape}; reels: ${Array.isArray(reels) ? reels.length : 'none'}]`
    );
  }

  const sorted = items
    .slice()
    .sort((a, b) => (Number(a.taken_at) || 0) - (Number(b.taken_at) || 0));
  const entries: DownloadEntry[] = [];
  for (const item of sorted) {
    const pk = String(item.pk ?? item.id ?? '');
    const entry = entryFromItem(
      item,
      `Instagram-story-${username}-${pk}`,
      `${IG_ORIGIN}/stories/${username}/${pk}/`
    );
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) {
    throw new Error('No downloadable media found in this story.');
  }
  return { site: 'Instagram', isPlaylist: entries.length > 1, entries };
}

/**
 * Probe a PUBLIC post without any login — the same logged-out GraphQL
 * query Instagram's own web app (and yt-dlp with impersonation) uses.
 * Returns every carousel child with photo + video CDN URLs. Throws
 * InstagramError('login_required') for private/gated posts and
 * ('not_found') for removed ones.
 */
export async function probeInstagramPostAnonymous(url: string): Promise<ProbeResult> {
  const shortcode = instagramPostShortcode(url);
  if (!shortcode) throw new Error('Not a recognizable Instagram post URL.');
  const pk = shortcodeToPk(shortcode);
  const postUrl = `https://www.instagram.com/p/${shortcode}/`;

  const lsd = await anonymousLsdToken();

  // The ruling call is what the web app does before rendering; Instagram
  // only honours X-CSRFToken on the GraphQL call when it said "ok" here.
  // Non-fatal: a flaky ruling must not block the actual query.
  let rulingOk = false;
  let csrf: string | undefined;
  try {
    const ruling = await igRequest(
      `${API_BASE}/web/get_ruling_for_content/?content_type=MEDIA&target_id=${pk}`,
      { mode: 'anonymous', headers: API_HEADERS, referrer: postUrl, timeoutMs: 15000 }
    );
    const parsed = tryParseJson(ruling.body);
    rulingOk = parsed?.status === 'ok';
    // Chromium keeps the jar; the csrftoken Instagram just set is in it.
    if (ruling.cookies) csrf = parseCookieJar(ruling.cookies).csrftoken;
  } catch {
    // ignore — proceed without the csrf header
  }

  const form = new URLSearchParams({
    lsd,
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: LOGGED_OUT_POST_QUERY,
    server_timestamps: 'true',
    variables: JSON.stringify({ media_id: pk }),
    doc_id: LOGGED_OUT_POST_DOC_ID,
  });
  const headers: Record<string, string> = {
    ...API_HEADERS,
    'X-FB-Friendly-Name': LOGGED_OUT_POST_QUERY,
    'X-FB-LSD': lsd,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (rulingOk && csrf) headers['X-CSRFToken'] = csrf;

  const data = await igApiJson(`${IG_ORIGIN}/api/graphql`, 'anonymous', {
    method: 'POST',
    headers,
    body: form.toString(),
    referrer: postUrl,
  });

  const payload = data.data as Record<string, unknown> | null | undefined;
  const errors = Array.isArray(data.errors) ? (data.errors as Array<Record<string, unknown>>) : [];
  const media = payload?.xig_polaris_media as Record<string, unknown> | null | undefined;
  if (!payload || (media === undefined && errors.length > 0)) {
    // A rotated query id or a Relay-level error is NOT a login wall —
    // keep it 'other' so the embed / yt-dlp fallbacks and the final error
    // don't send the user to the login screen for a public post.
    const first = typeof errors[0]?.message === 'string' ? (errors[0].message as string) : '';
    throw new InstagramError(
      'other',
      `Instagram GraphQL query failed${first ? `: ${first.slice(0, 160)}` : ''}`
    );
  }
  if (media === null) {
    // The query resolves but the media node is null: removed, or a
    // private post whose id the viewer may not see. Long shortcodes
    // (>28 chars) are private-post share links — say "login" for those.
    const kind: InstagramErrorKind = shortcode.length > 28 ? 'login_required' : 'not_found';
    throw new InstagramError(kind, instagramMessage(kind));
  }
  const product = media?.if_not_gated_logged_out as Record<string, unknown> | null | undefined;
  if (!product) {
    throw new InstagramError('login_required', instagramMessage('login_required'));
  }

  const entries = entriesFromProduct(product, shortcode);
  if (entries.length === 0) {
    throw new Error('No downloadable media found in this post.');
  }
  return { site: 'Instagram', isPlaylist: entries.length > 1, entries };
}

// ── Stories ─────────────────────────────────────────────────────────────

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

  // Primary: the web app's GraphQL story query (the REST reels_media path
  // below is soft-blocked for web sessions). A session-level refusal
  // (expired / checkpoint) is authoritative — surface it, don't fall
  // through to a REST path that will refuse the same way.
  try {
    return await probeInstagramStoryGraphql(username, storyId);
  } catch (e) {
    const kind = instagramErrorKind(e);
    if (kind === 'expired' || kind === 'checkpoint' || kind === 'rate_limited') throw e;
    // 'other' / no-items / bare-profile link → try the legacy REST path,
    // but leave a trace so a rotted query id doesn't silently degrade.
    logError('probe', e, `instagram story graphql: ${url}`);
  }

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
