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
