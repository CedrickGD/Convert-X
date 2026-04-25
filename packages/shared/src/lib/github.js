const REPO = "CedrickGD/Convert-X";
const CACHE_KEY = "convertx-latest-release";
const TTL_MS = 60 * 60 * 1000;

export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;

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

export function formatSize(bytes) {
  if (!bytes) return "";
  const u = ["B", "KB", "MB", "GB"];
  let s = bytes, i = 0;
  while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(s < 10 ? 1 : 0)} ${u[i]}`;
}
