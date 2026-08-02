/**
 * Tiny localStorage JSON wrapper shared by the download-side stores
 * (error log, history, recent URLs, pending batch, freshness stamps).
 *
 * Every accessor is guarded: localStorage can be absent (SSR, tests) or
 * throw (private-mode quotas), and persistence is always best-effort —
 * a storage failure must never break a download.
 */

function hasStorage() {
  try {
    return typeof localStorage !== "undefined" && localStorage !== null;
  } catch {
    return false;
  }
}

/** Read + parse a JSON value; `fallback` on missing/corrupt/unavailable. */
export function loadJson(key, fallback) {
  if (!hasStorage()) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Serialize + store a JSON value. Best-effort; never throws. */
export function saveJson(key, value) {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // non-fatal (quota, private mode)
  }
}

/** Remove a key. Best-effort; never throws. */
export function removeKey(key) {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // non-fatal
  }
}
