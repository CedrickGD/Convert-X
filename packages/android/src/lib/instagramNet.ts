/**
 * Instagram HTTP transport.
 *
 * Instagram fingerprints the TLS/HTTP2 client and answers anything that
 * is not a real browser with a JS shell, a login redirect, or an HTML
 * page where JSON was requested — even when the request carries a valid
 * session cookie. That is why a user who is demonstrably logged in (the
 * WebView login succeeded, cookies.txt holds `sessionid`) still saw every
 * post fail: React Native's fetch (OkHttp) and yt-dlp's Python stack both
 * look like bots. yt-dlp papers over it on desktop with curl_cffi
 * impersonation, which does not exist on Android.
 *
 * So every Instagram request goes through the native `webFetch` bridge —
 * a hidden Android System WebView, i.e. the device's actual Chromium —
 * which is the same engine the login happened in. cookies.txt remains
 * the single source of truth: the session cookies are installed into
 * the WebView jar before a logged-in request and anything else is
 * expired, so a logged-out account can never ride along; after each
 * logged-in response the jar is written back so rotated values
 * (csrftoken, rur) stay in sync for yt-dlp.
 *
 * When the bridge is unavailable (WebView missing/disabled, or an old
 * native build under a newer JS bundle) requests fall back to plain
 * fetch with a manual Cookie header — the pre-bridge behaviour.
 */

import * as Downloader from '../../modules/convert-x-downloader/src';
import {
  getCookiesForDomain,
  mergePlatformCookies,
  type CookieRecord,
} from './cookies';
import { LOGIN_USER_AGENT } from './loginPlatforms';

export const IG_ORIGIN = 'https://www.instagram.com';
const IG_DOMAIN = 'instagram.com';
const IG_COOKIE_DOMAIN = '.instagram.com';

export type IgRequestMode = 'session' | 'anonymous';

export type IgRequestOptions = {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  referrer?: string;
  userAgent?: string;
  timeoutMs?: number;
  /** `session` installs the cookies.txt Instagram cookies (logged-in
   *  request); `anonymous` guarantees NO session cookie is sent. */
  mode: IgRequestMode;
};

export type IgResponse = {
  status: number;
  /** Final URL after redirects — a bounce to /accounts/login means the
   *  session is dead (or the content needs one). */
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  body: string;
  /** Transport that produced this response. */
  via: 'webview' | 'fetch';
  /** The WebView jar for the origin after the response (`a=1; b=2`) —
   *  only the bridge can report it; plain fetch leaves it undefined. */
  cookies?: string;
};

/** What the WebView cookie jar currently represents, so consecutive
 *  requests in one mode don't re-sync the jar every time. */
let jarState: { mode: IgRequestMode; fingerprint: string } | null = null;
/** Bumped every time the WebView jar is replaced. Anonymous-session
 *  tokens (LSD) belong to one jar; callers key their caches on this. */
let transportEpoch = 0;

export function instagramTransportEpoch(): number {
  return transportEpoch;
}
/** After the native bridge rejected with WEBVIEW_UNAVAILABLE, skip it
 *  until this time — a WebView mid-update comes back within minutes, so a
 *  permanent latch would strand the user on the bot-fingerprinted path
 *  for the rest of the process. */
let bridgeUnavailableUntil = 0;
const BRIDGE_RETRY_MS = 2 * 60 * 1000;

/** Forget what we believe about the WebView jar. Call after cookies.txt
 *  changes outside this module (login, import, logout). */
export function resetInstagramTransport(): void {
  jarState = null;
  transportEpoch += 1;
  bridgeUnavailableUntil = 0;
}

function fingerprintOf(cookies: CookieRecord[]): string {
  return cookies
    .map((c) => `${c.name}=${c.value}`)
    .sort()
    .join('\n');
}

/** Pick one record per cookie name, preferring the apex-domain line
 *  (`.instagram.com`) a browser export or the in-app login writes. */
function dedupeForOrigin(cookies: CookieRecord[]): CookieRecord[] {
  const byName = new Map<string, CookieRecord>();
  const rank = (d: string) => {
    const dom = d.toLowerCase();
    if (dom === IG_COOKIE_DOMAIN || dom === IG_DOMAIN) return 0;
    if (dom === 'www.instagram.com' || dom === '.www.instagram.com') return 1;
    return 2;
  };
  for (const c of cookies) {
    const prev = byName.get(c.name);
    if (!prev || rank(c.domain) < rank(prev.domain)) byName.set(c.name, c);
  }
  return Array.from(byName.values()).map((c) => ({
    ...c,
    // Chromium only accepts Domain= values that cover the origin.
    domain: rank(c.domain) === 2 ? IG_COOKIE_DOMAIN : c.domain,
  }));
}

export function parseCookieJar(jar: string): Record<string, string> {
  return parseJar(jar);
}

function parseJar(jar: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of jar.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/**
 * Persist cookies Instagram rotated during a logged-in request. Only when
 * the jar still carries a session: a jar that lost `sessionid` means the
 * server logged us out, and writing THAT back would silently delete the
 * user's login from cookies.txt behind their back — the UI surfaces the
 * expiry instead.
 */
async function writeBackSession(jar: string, before: CookieRecord[]): Promise<void> {
  const map = parseJar(jar);
  if (!map.sessionid) return;
  const prev = fingerprintOf(before);
  const next = fingerprintOf(
    Object.entries(map).map(([name, value]) => ({ name, value, domain: IG_COOKIE_DOMAIN }))
  );
  if (prev === next) return;
  try {
    await mergePlatformCookies(IG_COOKIE_DOMAIN, map);
    jarState = { mode: 'session', fingerprint: next };
  } catch {
    // cookies.txt write failed — keep going with what we have.
  }
}

function isBridgeUnavailable(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  return (
    code === 'WEBVIEW_UNAVAILABLE' ||
    /WEBVIEW_UNAVAILABLE|WebView not installed|webview.*(missing|disabled|unavailable)/i.test(msg)
  );
}

async function viaPlainFetch(
  url: string,
  opts: IgRequestOptions,
  cookies: CookieRecord[]
): Promise<IgResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);
  try {
    const headers: Record<string, string> = {
      'User-Agent': opts.userAgent ?? LOGIN_USER_AGENT,
      ...(opts.headers ?? {}),
    };
    if (opts.mode === 'session' && cookies.length > 0) {
      headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
    if (opts.referrer) headers.Referer = opts.referrer;
    const resp = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body,
      // Keep RN's WebView-backed cookie jar out of it — cookies.txt is the
      // only source of truth for which account a request represents.
      credentials: 'omit',
      signal: controller.signal,
    });
    const body = await resp.text();
    const respHeaders: Record<string, string> = {};
    try {
      resp.headers.forEach((v, k) => {
        respHeaders[k.toLowerCase()] = v;
      });
    } catch {
      // ignore
    }
    return {
      status: resp.status,
      url: resp.url || url,
      redirected: resp.url !== undefined && resp.url !== '' && resp.url !== url,
      headers: respHeaders,
      body,
      via: 'fetch',
    };
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
 * Send one request to Instagram. See the module comment for why this is
 * not a plain fetch().
 */
export async function igRequest(url: string, opts: IgRequestOptions): Promise<IgResponse> {
  const sessionCookies =
    opts.mode === 'session' ? dedupeForOrigin(await getCookiesForDomain(IG_DOMAIN)) : [];
  if (opts.mode === 'session' && !sessionCookies.some((c) => c.name === 'sessionid')) {
    throw new Error('No Instagram login on this device — sign in under Credits → Platform logins.');
  }

  if (Date.now() >= bridgeUnavailableUntil && typeof Downloader.webFetch === 'function') {
    const fingerprint = opts.mode === 'session' ? fingerprintOf(sessionCookies) : '';
    const jarMatches = jarState?.mode === opts.mode && jarState.fingerprint === fingerprint;
    // The native side applies a 'replace' the moment the request is
    // dequeued, whether or not the fetch afterwards succeeds — so record
    // the jar's new state up front, and forget it on failure so the next
    // request re-syncs instead of trusting a jar we never confirmed.
    if (!jarMatches) {
      jarState = { mode: opts.mode, fingerprint };
      transportEpoch += 1;
    }
    try {
      const result = await Downloader.webFetch({
        url,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        body: opts.body,
        referrer: opts.referrer,
        userAgent: opts.userAgent ?? LOGIN_USER_AGENT,
        timeoutMs: opts.timeoutMs ?? 20000,
        cookieMode: jarMatches ? 'keep' : 'replace',
        cookies: jarMatches ? [] : sessionCookies,
      });
      if (opts.mode === 'session') {
        const jar = result.cookies ? parseJar(result.cookies) : {};
        if (!jar.sessionid) {
          // Something outside this module emptied the WebView jar (the
          // login screen's clearAll, or Instagram revoking the session):
          // re-install cookies.txt on the next logged-in request.
          jarState = null;
        } else if (result.cookies) {
          await writeBackSession(result.cookies, sessionCookies);
        }
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(result.headers ?? {})) headers[k.toLowerCase()] = v;
      return {
        status: result.status,
        url: result.url || url,
        redirected: !!result.redirected,
        headers,
        body: result.body ?? '',
        via: 'webview',
        cookies: result.cookies || undefined,
      };
    } catch (e) {
      jarState = null;
      if (!isBridgeUnavailable(e)) throw e;
      bridgeUnavailableUntil = Date.now() + BRIDGE_RETRY_MS;
      console.warn(
        '[instagramNet] WebView bridge unavailable, falling back to fetch:',
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  return viaPlainFetch(url, opts, sessionCookies);
}
