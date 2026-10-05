// convertx-api — the Cloudflare Worker in front of the Convert-X NAS.
//
// Public (no key):
//   GET  /v1/health
//   GET|HEAD /v1/media?url=        allowlisted Discord/Tenor/Giphy/Klipy media,
//                                  for the web build's non-CORS-safe fetches
//   GET  /v1/resolve/klipy?type=&slug=   Klipy page → media files (API key here)
//   GET  /v1/file/:jobId?t=        finished download, token-gated on the NAS
// Keyed (Authorization: Bearer <access key>):
//   *    /v1/dl/*                  forwarded to the NAS over Workers VPC
//
// The NAS has no public hostname: env.NAS is a Workers VPC service bound to
// a Cloudflare Tunnel, so this Worker is its only way in. The Worker proves
// itself to the NAS with ORIGIN_KEY and tells it which access key was used
// (per-key limits) and who asked (logs).

import { isAllowedMediaHost } from "../../shared/src/core/discordMedia.js";

const NAS_ORIGIN = "http://convertx-api:8080";
const MEDIA_CAP = 50 * 1024 * 1024;
const BODY_CAP = 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([101, 204, 205, 304]);
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.convert-x-online\.pages\.dev$/;
const KLIPY_TYPES = new Set(["gifs", "stickers", "clips", "memes"]);
const KLIPY_SLUG = /^[a-z0-9-]{1,200}$/i;
const JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN = /^[0-9a-f]{16,128}$/i;
const DL_PATH = /^[A-Za-z0-9._~/-]*$/;
const UA = "Mozilla/5.0 (compatible; ConvertX-Gateway/1.0; +https://convert-x-online.pages.dev)";

const PUBLIC_EXPOSE = "Content-Type, Content-Length, Content-Range, X-Final-Url";
const PRIVATE_EXPOSE = "Content-Type, Content-Length, Content-Range, Content-Disposition, X-Final-Url, X-Upstream-Status, Retry-After";

// ── helpers ─────────────────────────────────────────────────────────────────

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

/** Re-wrap a response so its headers are mutable, then add `extra`. */
function decorate(res, extra) {
  const out = new Response(NULL_BODY.has(res.status) ? null : res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  out.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  return out;
}

/** Origins allowed to read keyed responses: the configured list + Pages previews. */
export function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes(origin)) return origin;
  if (PREVIEW_ORIGIN.test(origin)) return origin;
  return null;
}

function corsFor(scope, request, env) {
  if (scope === "public") {
    return { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": PUBLIC_EXPOSE };
  }
  const origin = allowedOrigin(request.headers.get("Origin"), env);
  const h = { Vary: "Origin", "Access-Control-Expose-Headers": PRIVATE_EXPOSE };
  if (origin) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function preflight(cors) {
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, DELETE, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}

const encoder = new TextEncoder();

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(s))));
}

/**
 * Constant-time string compare: both sides are hashed first, so neither the
 * content nor the length of the secret leaks through timing.
 */
export async function timingSafeEqualStr(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(ha, hb);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

let keysCache = { raw: null, keys: [] };

/** ACCESS_KEYS = "name:key,name2:key2" (commas or newlines). Keys under 16 chars are ignored. */
export function parseAccessKeys(raw) {
  if (keysCache.raw === raw) return keysCache.keys;
  const keys = [];
  for (const part of String(raw || "").split(/[,\n]/)) {
    const entry = part.trim();
    if (!entry) continue;
    const i = entry.indexOf(":");
    const name = i > 0 ? entry.slice(0, i).trim() : "";
    const key = i > 0 ? entry.slice(i + 1).trim() : "";
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name) || key.length < 16) {
      console.warn(`ACCESS_KEYS: ignoring malformed entry "${name || "(no name)"}" (want name:key, key ≥ 16 chars)`);
      continue;
    }
    keys.push({ name, key });
  }
  keysCache = { raw, keys };
  return keys;
}

/** The key's name when `presented` matches one; checks every key (no early exit). */
export async function matchAccessKey(env, presented) {
  if (!presented) return null;
  let found = null;
  for (const k of parseAccessKeys(env.ACCESS_KEYS)) {
    if ((await timingSafeEqualStr(k.key, presented)) && found === null) found = k.name;
  }
  return found;
}

/** Count bytes through a stream and error it once `cap` is passed. */
export function capStream(body, cap) {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > cap) {
          controller.error(new Error(`Response exceeds ${cap} bytes`));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function readCapped(request, cap) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  const buf = await request.arrayBuffer();
  return buf.byteLength > cap ? null : buf;
}

// ── /v1/media ───────────────────────────────────────────────────────────────

async function media(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "Method not allowed" });
  const raw = url.searchParams.get("url") || "";
  let current;
  try {
    current = new URL(raw);
  } catch {
    return json(400, { error: "Pass an https media URL as ?url=" });
  }
  // Check both the raw string (the shared allowlist's own parse) and the
  // WHATWG-normalised URL we will actually fetch.
  if (raw.length > 4096 || !isAllowedMediaHost(raw) || !isAllowedMediaHost(current.href)) {
    return json(403, { error: "That host isn't on the media allowlist" });
  }

  const headers = { "User-Agent": UA, Accept: "*/*" };
  const range = request.headers.get("Range");
  if (range) headers.Range = range;

  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await fetch(current.href, {
        method: request.method,
        headers,
        redirect: "manual",
        cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "300-599": 0 } },
      });
    } catch {
      return json(502, { error: "Couldn't reach the media host" });
    }
    const loc = res.headers.get("Location");
    if (REDIRECTS.has(res.status) && loc) {
      if (hop >= MAX_REDIRECTS) return json(502, { error: "Too many redirects" });
      let next;
      try {
        next = new URL(loc, current);
      } catch {
        return json(502, { error: "Upstream sent an invalid redirect" });
      }
      if (!isAllowedMediaHost(next.href)) return json(403, { error: "Redirected to a host that isn't allowed" });
      current = next;
      continue;
    }

    const len = Number(res.headers.get("Content-Length"));
    if (res.headers.has("Content-Length") && Number.isFinite(len) && len > MEDIA_CAP) {
      return json(413, { error: "That file is larger than 50 MB" });
    }
    const out = new Headers();
    for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
      const v = res.headers.get(h);
      if (v !== null) out.set(h, v);
    }
    out.set("Cache-Control", res.status >= 200 && res.status < 300 ? "public, max-age=86400" : "no-store");
    out.set("X-Final-Url", current.href);
    let body = null;
    if (request.method !== "HEAD" && !NULL_BODY.has(res.status) && res.body) {
      // A known length is already bounded by the check above (and stays
      // intact on the wire); an unknown one is counted.
      body = res.headers.has("Content-Length") ? res.body : capStream(res.body, MEDIA_CAP);
    }
    return new Response(body, { status: res.status, headers: out });
  }
}

// ── /v1/resolve/klipy ───────────────────────────────────────────────────────

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Klipy API answer → {title, files:{hd|md|sm|xs:{gif|webp|mp4|webm|jpg|png:{url,width,height,size}}}} | null */
export function normaliseKlipy(payload, slug) {
  const d = payload && typeof payload === "object" ? payload.data : null;
  let items = [];
  if (Array.isArray(d)) items = d;
  else if (d && Array.isArray(d.data)) items = d.data;
  else if (d && typeof d === "object" && (d.file || d.files)) items = [d];
  else if (payload && Array.isArray(payload.items)) items = payload.items;
  items = items.filter((i) => i && typeof i === "object");
  const want = String(slug || "").toLowerCase();
  const item = items.find((i) => String(i.slug || "").toLowerCase() === want) || items[0];
  if (!item) return null;
  const raw = item.file || item.files;
  if (!raw || typeof raw !== "object") return null;
  const files = {};
  for (const tier of ["hd", "md", "sm", "xs"]) {
    const t = raw[tier];
    if (!t || typeof t !== "object") continue;
    const formats = {};
    for (const fmt of ["gif", "webp", "mp4", "webm", "jpg", "png"]) {
      const n = t[fmt];
      if (n && typeof n.url === "string" && /^https:\/\//i.test(n.url)) {
        formats[fmt] = { url: n.url, width: num(n.width), height: num(n.height), size: num(n.size) };
      }
    }
    if (Object.keys(formats).length) files[tier] = formats;
  }
  if (!Object.keys(files).length) return null;
  return { title: typeof item.title === "string" ? item.title : null, files };
}

async function klipy(request, env, url) {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!env.KLIPY_API_KEY) return json(501, { error: "Klipy lookups aren't set up on this gateway" });
  const type = url.searchParams.get("type") || "";
  const slug = url.searchParams.get("slug") || "";
  if (!KLIPY_TYPES.has(type) || !KLIPY_SLUG.test(slug)) return json(400, { error: "Pass type=gifs|stickers|clips|memes and a slug" });

  let res;
  try {
    res = await fetch(
      `https://api.klipy.com/api/v1/${encodeURIComponent(env.KLIPY_API_KEY)}/${type}/items?slugs=${encodeURIComponent(slug)}`,
      { headers: { Accept: "application/json", "User-Agent": UA }, cf: { cacheEverything: true, cacheTtl: 3600 } },
    );
  } catch {
    return json(502, { error: "Klipy is unreachable right now" });
  }
  if (res.status === 404) return json(404, { error: "Klipy item not found" });
  if (!res.ok) return json(502, { error: `Klipy lookup failed (HTTP ${res.status})` });
  let payload;
  try {
    payload = await res.json();
  } catch {
    return json(502, { error: "Klipy sent an unreadable answer" });
  }
  const norm = normaliseKlipy(payload, slug);
  if (!norm) return json(404, { error: "Klipy item not found" });
  return json(200, norm, { "Cache-Control": "public, max-age=3600" });
}

// ── NAS forwarding ──────────────────────────────────────────────────────────

async function toNas(env, path, init) {
  if (!env.NAS || typeof env.NAS.fetch !== "function") return json(503, { error: "Downloader offline" });
  try {
    return await env.NAS.fetch(`${NAS_ORIGIN}${path}`, init);
  } catch (e) {
    console.warn("NAS fetch failed:", e && e.message);
    return json(503, { error: "Downloader offline" });
  }
}

async function file(request, env, url, jobId) {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "Method not allowed" });
  const t = url.searchParams.get("t") || "";
  if (!JOB_ID.test(jobId) || !TOKEN.test(t)) return json(404, { error: "File not found — it may have expired" });
  const headers = {};
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers["X-ConvertX-Client-IP"] = ip;
  return toNas(env, `/jobs/${jobId}/file?t=${encodeURIComponent(t)}`, { method: request.method, headers });
}

async function dl(request, env, url, rest) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
  const keyId = m ? await matchAccessKey(env, m[1]) : null;
  if (!keyId) return json(401, { error: "Invalid access key" }, { "WWW-Authenticate": 'Bearer realm="convertx"' });
  if (!["GET", "HEAD", "POST", "DELETE"].includes(request.method)) return json(405, { error: "Method not allowed" });
  if (!DL_PATH.test(rest) || rest.split("/").some((s) => s === "." || s === "..")) {
    return json(404, { error: "Not found" });
  }
  if (!env.ORIGIN_KEY) return json(503, { error: "Downloader offline" });

  const headers = {
    "X-ConvertX-Origin-Key": env.ORIGIN_KEY,
    "X-ConvertX-Key-Id": keyId,
  };
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) headers["X-ConvertX-Client-IP"] = ip;
  for (const h of ["Content-Type", "Accept", "Range"]) {
    const v = request.headers.get(h);
    if (v) headers[h] = v;
  }
  let body;
  if (request.method === "POST") {
    body = await readCapped(request, BODY_CAP);
    if (body === null) return json(413, { error: "Request body too large" });
  }
  const res = await toNas(env, `/${rest}${url.search}`, { method: request.method, headers, body });
  if (!res.headers.has("Cache-Control")) {
    const out = decorate(res, {});
    out.headers.set("Cache-Control", "no-store");
    return out;
  }
  return res;
}

// ── router ──────────────────────────────────────────────────────────────────

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const isPrivate = path === "/v1/dl" || path.startsWith("/v1/dl/") || path.startsWith("/v1/file/");
  const cors = corsFor(isPrivate ? "private" : "public", request, env);
  const finish = (res) => decorate(res, cors);

  if (request.method === "OPTIONS") return finish(preflight(cors));

  if (path === "/v1/health") {
    if (request.method !== "GET" && request.method !== "HEAD") return finish(json(405, { error: "Method not allowed" }));
    return finish(json(200, { ok: true, service: "convertx-gateway", downloader: !!env.NAS, klipy: !!env.KLIPY_API_KEY }));
  }
  if (path === "/v1/media") return finish(await media(request, url));
  if (path === "/v1/resolve/klipy") return finish(await klipy(request, env, url));
  let m = path.match(/^\/v1\/file\/([^/]+)$/);
  if (m) return finish(await file(request, env, url, m[1]));
  m = path.match(/^\/v1\/dl\/(.*)$/);
  if (m) return finish(await dl(request, env, url, m[1]));
  return finish(json(404, { error: "Not found" }));
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (e) {
      console.error("gateway error:", e && e.stack ? e.stack : e);
      const res = json(500, { error: "Gateway error" });
      res.headers.set("Access-Control-Allow-Origin", "*");
      res.headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return res;
    }
  },
};
