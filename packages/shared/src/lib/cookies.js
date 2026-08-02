/**
 * Shared cookies.txt logic for yt-dlp.
 *
 * A single Netscape cookies.txt (canonical file: platform
 * getCookiesFilePath(), i.e. <app_local_data_dir>/cookies.txt) holds
 * cookies for every platform the user has signed into. yt-dlp selects the
 * lines matching the URL's domain, so merging is per-domain: signing into
 * a new platform must not wipe the others, and signing out of one must
 * leave the rest intact.
 *
 * All file access goes through the platform adapter's readCookiesText /
 * writeCookiesText / getCookiesFilePath (feature-detected — on web these
 * are absent and every function degrades to "no cookies"). The same file
 * feeds yt-dlp's --cookies and the JS probers' Cookie headers, so "works
 * in downloads" and "works in the JS prober" can never disagree.
 */

import { getPlatform } from "../platform.js";

const HEADER = "# Netscape HTTP Cookie File";

function adapter() {
  try {
    return getPlatform();
  } catch {
    return null;
  }
}

function canReadCookies(p) {
  return !!p && typeof p.readCookiesText === "function";
}

function canWriteCookies(p) {
  return !!p && typeof p.writeCookiesText === "function";
}

function baseDomain(cookieDomain) {
  return String(cookieDomain).replace(/^\./, "").toLowerCase();
}

/**
 * Does this cookies.txt line belong to `base` (e.g. "x.com")? Matches the
 * domain itself and any subdomain, but the required leading dot stops
 * "x.com" from swallowing "netflix.com". `#HttpOnly_` prefixed rows are
 * real cookies (browser exports mark httpOnly cookies that way, and
 * sessionid/auth_token ARE httpOnly) — strip the prefix before matching.
 */
function lineBelongsTo(line, base) {
  const domain = (line.split("\t")[0] ?? "").trim().toLowerCase().replace(/^#httponly_/, "");
  return domain === base || domain.endsWith("." + base);
}

/** Split cookies text into cookie rows: keeps `#HttpOnly_` rows, drops
 *  blank lines and other comments. */
function linesFromText(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return text.split("\n").filter((l) => {
    const t = l.trim();
    if (t.length === 0) return false;
    return !t.startsWith("#") || /^#HttpOnly_/i.test(t);
  });
}

async function readLines() {
  const p = adapter();
  if (!canReadCookies(p)) return [];
  try {
    const text = await p.readCookiesText();
    return linesFromText(text ?? "");
  } catch {
    return [];
  }
}

async function writeLines(lines) {
  const p = adapter();
  if (!canWriteCookies(p)) return;
  if (lines.length === 0) {
    // Empty text deletes the file (adapter contract) — "no cookies on
    // disk" must read as logged-out everywhere.
    await p.writeCookiesText("");
    return;
  }
  await p.writeCookiesText([HEADER, ...lines].join("\n") + "\n");
}

/**
 * The on-disk cookies.txt is the source of truth for "am I logged in".
 * Returns the canonical path (the form yt-dlp's --cookies expects) when
 * the file exists with content, else null.
 */
export async function resolveCookiesPath() {
  const p = adapter();
  if (!canReadCookies(p) || typeof p.getCookiesFilePath !== "function") return null;
  try {
    const text = await p.readCookiesText();
    if (typeof text === "string" && text.trim().length > 0) {
      return await p.getCookiesFilePath();
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Does cookies.txt hold cookies for a specific domain (e.g.
 * "instagram.com")? The file is shared across every platform, so "a
 * cookie file exists" does NOT mean "logged into this platform" — probe
 * gates that need per-platform auth (the anonymous-Instagram fallback)
 * must check the domain, or a user logged into an unrelated site
 * (YouTube) loses the anonymous path.
 */
export async function hasCookiesForDomain(cookieDomain) {
  const base = baseDomain(cookieDomain);
  const lines = await readLines();
  return lines.some((l) => lineBelongsTo(l, base));
}

/**
 * Build a `Cookie:` request-header value from cookies.txt for one domain.
 * Used by the JS-side API probers (Instagram stories) that hit private
 * endpoints directly instead of going through yt-dlp. Returns undefined
 * when no cookies exist for the domain.
 */
export async function getCookieHeaderForDomain(cookieDomain) {
  const base = baseDomain(cookieDomain);
  const pairs = [];
  for (const line of await readLines()) {
    if (!lineBelongsTo(line, base)) continue;
    // domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
    const fields = line.split("\t");
    const name = fields[5]?.trim();
    const value = fields[6]?.trim();
    if (name && value !== undefined) pairs.push(`${name}=${value}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

/**
 * Read a single cookie's value for a domain from cookies.txt (e.g. the
 * csrftoken Instagram's web API wants echoed in an X-CSRFToken header).
 */
export async function getCookieValue(cookieDomain, name) {
  const base = baseDomain(cookieDomain);
  for (const line of await readLines()) {
    if (!lineBelongsTo(line, base)) continue;
    const fields = line.split("\t");
    if (fields[5]?.trim() === name) return fields[6]?.trim();
  }
  return undefined;
}

/**
 * Write harvested cookies into cookies.txt, replacing only the lines that
 * belong to `domainSuffixes` (a domain string like ".instagram.com" or an
 * array of them).
 *
 * `rows` is either a plain `{ name: value }` map (all rows written under
 * the first domain suffix), or an array of cookie objects
 * `{ name, value, domain?, path?, secure?, httpOnly? }` as harvested from
 * the login window. Rows always get a synthetic 1-year expiry — session
 * cookies with no expiry would be dropped by yt-dlp's cookiejar as
 * non-persistent. httpOnly rows are written with the `#HttpOnly_` prefix
 * browser exports use.
 *
 * Returns the canonical cookies path (or null when the adapter can't
 * report one).
 */
export async function mergePlatformCookies(domainSuffixes, rows) {
  const suffixes = Array.isArray(domainSuffixes) ? domainSuffixes : [domainSuffixes];
  const bases = suffixes.map(baseDomain);
  const kept = (await readLines()).filter((l) => !bases.some((b) => lineBelongsTo(l, b)));

  // 1-year synthetic expiry — see doc comment above.
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  const fresh = [];
  const defaultDomain = suffixes[0];

  const pushRow = (name, value, domain, path, secure, httpOnly) => {
    if (!name || !value) return;
    // Netscape format: the includeSubdomains column MUST agree with whether
    // the domain starts with a dot — Python's http.cookiejar asserts on it and
    // yt-dlp rejects the WHOLE file if any row disagrees. WebView2 reports
    // host-only cookies dot-less, so promote them to domain cookies (what the
    // native app does by always writing the registry's dotted domain) rather
    // than writing FALSE, which would stop them reaching www./i. subdomains.
    const dotted = domain.startsWith(".") ? domain : `.${domain}`;
    // domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
    const domainField = (httpOnly ? "#HttpOnly_" : "") + dotted;
    fresh.push(
      [
        domainField,
        "TRUE",
        path || "/",
        secure === false ? "FALSE" : "TRUE",
        String(expires),
        name,
        value,
      ].join("\t")
    );
  };

  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (!row) continue;
      pushRow(
        row.name,
        row.value,
        row.domain && String(row.domain).length > 0 ? row.domain : defaultDomain,
        row.path,
        row.secure,
        !!row.httpOnly
      );
    }
  } else if (rows && typeof rows === "object") {
    for (const [name, value] of Object.entries(rows)) {
      pushRow(name, value, defaultDomain, "/", true, false);
    }
  }

  await writeLines([...kept, ...fresh]);

  const p = adapter();
  if (p && typeof p.getCookiesFilePath === "function") {
    try {
      return await p.getCookiesFilePath();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Drop the given domain(s)' lines from cookies.txt. Deletes the file
 * entirely when nothing is left. Returns true if any cookies remain
 * afterwards.
 */
export async function removePlatformCookies(domainSuffixes) {
  const suffixes = Array.isArray(domainSuffixes) ? domainSuffixes : [domainSuffixes];
  const bases = suffixes.map(baseDomain);
  const kept = (await readLines()).filter((l) => !bases.some((b) => lineBelongsTo(l, b)));
  await writeLines(kept);
  return kept.length > 0;
}

/**
 * Replace the whole cookies.txt with user-supplied text (the "Import a
 * cookies.txt" flow). Empty/whitespace text deletes the file. Returns the
 * canonical cookies path when content was written, else null.
 */
export async function importCookiesText(text) {
  const p = adapter();
  if (!canWriteCookies(p)) return null;
  const trimmed = typeof text === "string" ? text : "";
  await p.writeCookiesText(trimmed);
  if (trimmed.trim().length === 0) return null;
  return resolveCookiesPath();
}
