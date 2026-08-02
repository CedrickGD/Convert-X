const REPO = "CedrickGD/Convert-X";
const CACHE_KEY = "convertx-latest-release";
const DESKTOP_CACHE_KEY = "convertx-latest-desktop-release";
const TTL_MS = 60 * 60 * 1000;

export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const WEB_URL = "https://convert-x-online.pages.dev";

export async function fetchLatestRelease() {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      const { ts, data } = JSON.parse(cached);
      if (Date.now() - ts < TTL_MS) return data;
    }
  } catch {}

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const data = {
      tagName: json.tag_name,
      name: json.name,
      publishedAt: json.published_at,
      htmlUrl: json.html_url,
      assets: (json.assets || []).map((a) => ({
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
        contentType: a.content_type,
      })),
    };
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch {}
    return data;
  } catch {
    return null;
  }
}

export function pickWindowsAssets(release) {
  if (!release || !release.assets) return { msi: null, exe: null };
  const msi = release.assets.find((a) => a.name.toLowerCase().endsWith(".msi")) || null;
  const exe = release.assets.find((a) => a.name.toLowerCase().endsWith(".exe")) || null;
  return { msi, exe };
}

// The monorepo holds BOTH desktop (`desktop-v*`, MSI) and android (`v*`, APK)
// releases, so `/releases/latest` is unreliable for the desktop updater. List
// releases and return the newest published one whose tag is `desktop-v*` and
// that ships a Windows installer.
// Memoized for TTL_MS like fetchLatestRelease: the promo card is re-mounted on
// every Download<->Credits switch, and the API is unauthenticated (60 req/h per
// IP). `force` skips the cache for an explicit "check for updates" click.
export async function fetchLatestDesktopRelease({ force = false } = {}) {
  if (!force) {
    try {
      const cached = sessionStorage.getItem(DESKTOP_CACHE_KEY);
      if (cached) {
        const { ts, data } = JSON.parse(cached);
        if (Date.now() - ts < TTL_MS) return data;
      }
    } catch {}
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return null;
    const list = await res.json();
    for (const json of list) {
      if (json.draft || json.prerelease) continue;
      if (!String(json.tag_name).startsWith("desktop-v")) continue;
      const assets = (json.assets || []).map((a) => ({
        name: a.name,
        size: a.size,
        downloadUrl: a.browser_download_url,
        contentType: a.content_type,
      }));
      const win = assets.find((a) => /\.(msi|exe)$/i.test(a.name));
      if (!win) continue;
      const data = {
        tagName: json.tag_name,
        version: String(json.tag_name).replace(/^desktop-v/, ""),
        name: json.name,
        notes: json.body || "",
        publishedAt: json.published_at,
        htmlUrl: json.html_url,
        assets,
      };
      // Only successes are cached — a transient 403 must not pin the
      // "View Releases" fallback for the rest of the session.
      try {
        sessionStorage.setItem(DESKTOP_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
      } catch {}
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

// True if `latest` (dotted semver) is strictly newer than `current`.
export function isNewerVersion(latest, current) {
  const pa = String(latest || "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(current || "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const a = pa[i] || 0;
    const b = pb[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return false;
}

export function formatSize(bytes) {
  if (!bytes) return "";
  const u = ["B", "KB", "MB", "GB"];
  let s = bytes, i = 0;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(s < 10 ? 1 : 0)} ${u[i]}`;
}
