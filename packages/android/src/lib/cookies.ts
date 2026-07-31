/**
 * Shared cookies.txt storage for yt-dlp.
 *
 * A single Netscape cookies.txt holds cookies for every platform the user
 * has signed into. yt-dlp selects the lines matching the URL's domain, so
 * merging is per-domain: signing into a new platform must not wipe the
 * others, and signing out of one must leave the rest intact.
 */

import * as FileSystem from 'expo-file-system/legacy';

const COOKIES_FILE = `${FileSystem.documentDirectory ?? ''}cookies.txt`;
/** Bare path (no file:// scheme) — the form yt-dlp's --cookies expects. */
export const COOKIES_PATH = COOKIES_FILE.replace(/^file:\/\//, '');

const HEADER = '# Netscape HTTP Cookie File';

function baseDomain(cookieDomain: string): string {
  return cookieDomain.replace(/^\./, '').toLowerCase();
}

/**
 * Does this cookies.txt line belong to `base` (e.g. "x.com")? Matches the
 * domain itself and any subdomain, but the required leading dot stops
 * "x.com" from swallowing "netflix.com".
 */
function lineBelongsTo(line: string, base: string): boolean {
  const domain = (line.split('\t')[0] ?? '').trim().toLowerCase().replace(/^#httponly_/, '');
  return domain === base || domain.endsWith('.' + base);
}

/**
 * The on-disk cookies.txt is the source of truth for "am I logged in".
 * Returns the bare path if the file exists (and is non-trivial), else
 * undefined. Probe/download resolve cookies through this so a momentarily
 * stale `state.settings.cookiesPath` can't make a logged-in user look
 * logged-out — the bug where the first private-post download failed with
 * "login required" until the user re-logged in.
 */
export async function resolveCookiesPath(): Promise<string | undefined> {
  try {
    const info = await FileSystem.getInfoAsync(COOKIES_FILE);
    if (info.exists && (!('size' in info) || (info.size ?? 1) > 0)) return COOKIES_PATH;
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Does cookies.txt hold cookies for a specific domain (e.g. "instagram.com")?
 * The file is shared across every platform, so "a cookie file exists" does
 * NOT mean "logged into this platform" — probe gates that need per-platform
 * auth (the anonymous-Instagram fallback) must check the domain, or a user
 * logged into an unrelated site (YouTube) loses the anonymous path.
 */
export async function hasCookiesForDomain(cookieDomain: string): Promise<boolean> {
  const base = baseDomain(cookieDomain);
  const lines = await readLines();
  return lines.some((l) => lineBelongsTo(l, base));
}

async function readLines(): Promise<string[]> {
  try {
    const txt = await FileSystem.readAsStringAsync(COOKIES_FILE);
    // Keep cookie rows; drop blank lines and comments — but NOT the
    // `#HttpOnly_...` rows, which are real cookies (browser exports mark
    // httpOnly cookies that way, and sessionid/auth_token are httpOnly).
    return txt.split('\n').filter((l) => {
      const t = l.trim();
      if (t.length === 0) return false;
      return !t.startsWith('#') || /^#HttpOnly_/i.test(t);
    });
  } catch {
    return [];
  }
}

/**
 * Build a `Cookie:` request-header value from cookies.txt for one domain.
 * Used by JS-side API probers (Instagram stories) that fetch() private
 * endpoints directly instead of going through yt-dlp — the header is
 * assembled from the same on-disk source of truth yt-dlp reads, so "works
 * in downloads" and "works in the JS prober" can never disagree.
 * Returns undefined when no cookies exist for the domain.
 */
export async function getCookieHeaderForDomain(
  cookieDomain: string
): Promise<string | undefined> {
  const base = baseDomain(cookieDomain);
  const pairs: string[] = [];
  for (const line of await readLines()) {
    if (!lineBelongsTo(line, base)) continue;
    // domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
    const fields = line.split('\t');
    const name = fields[5]?.trim();
    const value = fields[6]?.trim();
    if (name && value !== undefined) pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join('; ') : undefined;
}

/**
 * Read a single cookie's value for a domain from cookies.txt (e.g. the
 * csrftoken Instagram's web API wants echoed in an X-CSRFToken header).
 */
export async function getCookieValue(
  cookieDomain: string,
  name: string
): Promise<string | undefined> {
  const base = baseDomain(cookieDomain);
  for (const line of await readLines()) {
    if (!lineBelongsTo(line, base)) continue;
    const fields = line.split('\t');
    if (fields[5]?.trim() === name) return fields[6]?.trim();
  }
  return undefined;
}

/**
 * Write `cookieMap` for `cookieDomain` into cookies.txt, replacing only
 * that domain's existing lines. Returns the bare cookies path.
 */
export async function mergePlatformCookies(
  cookieDomain: string,
  cookieMap: Record<string, string>
): Promise<string> {
  const base = baseDomain(cookieDomain);
  const kept = (await readLines()).filter((l) => !lineBelongsTo(l, base));
  // 1-year expiry — session cookies with no expiry would be dropped by
  // yt-dlp's cookiejar as non-persistent.
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  const fresh: string[] = [];
  for (const [name, value] of Object.entries(cookieMap)) {
    if (!value) continue;
    // domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
    fresh.push([cookieDomain, 'TRUE', '/', 'TRUE', String(expires), name, value].join('\t'));
  }
  const out = [HEADER, ...kept, ...fresh].join('\n') + '\n';
  await FileSystem.writeAsStringAsync(COOKIES_FILE, out);
  return COOKIES_PATH;
}

/**
 * Drop `cookieDomain`'s lines from cookies.txt. Deletes the file entirely
 * when nothing is left. Returns true if any cookies remain afterwards.
 */
export async function removePlatformCookies(cookieDomain: string): Promise<boolean> {
  const base = baseDomain(cookieDomain);
  const kept = (await readLines()).filter((l) => !lineBelongsTo(l, base));
  if (kept.length === 0) {
    await FileSystem.deleteAsync(COOKIES_FILE, { idempotent: true }).catch(() => {});
    return false;
  }
  await FileSystem.writeAsStringAsync(COOKIES_FILE, [HEADER, ...kept].join('\n') + '\n');
  return true;
}
