// HTTP routes of convertx-api. Reached only through the Cloudflare tunnel:
// the gateway Worker authenticates the user's access key and forwards with
// X-ConvertX-Origin-Key; everything except /health and the token-gated file
// download requires that key.
//
//   GET    /health
//   POST   /probe          {url}                          → ProbeResult (desktop shape)
//   POST   /http           {url,method,headers,body,timeoutMs} → {status, body, headers}
//   GET    /direct?url=&name=                             → upstream bytes (status passthrough)
//   GET    /image?url=                                    → image bytes (≤10 MB)
//   POST   /jobs           {url,format,quality,…}         → 202 {jobId, token}
//   GET    /jobs/:id                                      → job state
//   GET    /jobs/:id/file?t=<token>                       → the finished file
//   DELETE /jobs/:id                                      → cancel / discard
//   POST   /engine/update                                 → {status, version}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EgressBlockedError } from "./ipguard.mjs";
import { HttpError, validateHttpUrl } from "./jobs.mjs";
import { redactUrl } from "./log.mjs";
import {
  TooLargeError,
  decodeText,
  isProxyAllowedHost,
  joinRawHeaders,
  readBody,
} from "./safeFetch.mjs";

const JSON_LIMIT = 1024 * 1024;
const HTTP_BODY_LIMIT = 16 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST"]);
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
// Never let a caller steer the connection itself.
const BLOCKED_REQ_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
]);

const MIME = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  aac: "audio/aac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
};

// ── helpers ─────────────────────────────────────────────────────────────────

function sendJson(res, status, obj, headers = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readJson(req, limit = JSON_LIMIT) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      reject(new HttpError(413, "Request body too large"));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Port of net.rs sanitize_file_name (+ control characters for header safety). */
export function sanitizeFileName(name) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "").trim();
  return cleaned || "download";
}

/** RFC 6266: ASCII fallback + UTF-8 filename*. */
export function contentDisposition(name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const asciiStem = stem
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\%]/g, "_")
    .trim();
  const asciiExt = ext.replace(/[^\x20-\x7e]/g, "").replace(/["\\%]/g, "_");
  const ascii = `${asciiStem || "download"}${asciiExt}`;
  const star = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

function mimeFor(file) {
  return MIME[path.extname(file).slice(1).toLowerCase()] || "application/octet-stream";
}

/** Sha-256 both sides first so the compare is constant-time for any length. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

function headerValue(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function cleanRequestHeaders(raw) {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "headers must be an object");
  const entries = Object.entries(raw);
  if (entries.length > 50) throw new HttpError(400, "Too many headers");
  const out = {};
  for (const [k, v] of entries) {
    if (!HEADER_NAME_RE.test(k)) throw new HttpError(400, `Invalid header name: ${k.slice(0, 40)}`);
    if (BLOCKED_REQ_HEADERS.has(k.toLowerCase())) continue;
    const val = String(v);
    // eslint-disable-next-line no-control-regex
    if (val.length > 8192 || /[\r\n\u0000]/.test(val)) throw new HttpError(400, `Invalid value for header ${k}`);
    out[k] = val;
  }
  return out;
}

/** Abort upstream work when the caller goes away mid-request. */
function abortOnClose(req, res) {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac;
}

function upstreamError(res, e, timeoutMs = null) {
  if (e instanceof EgressBlockedError) return sendJson(res, 403, { error: e.message });
  if (e instanceof TooLargeError) return sendJson(res, 413, { error: e.message });
  if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message }, e.headers);
  if (timeoutMs !== null && (e?.name === "AbortError" || e?.code === "ABORT_ERR" || e?.code === "TIMEOUT")) {
    return sendJson(res, 504, { error: `Request timed out after ${timeoutMs}ms` });
  }
  if (e?.code === "STALLED") return sendJson(res, 504, { error: e.message });
  const why = e?.code && /^E[A-Z]+$/.test(e.code) ? e.code : e?.message || "error";
  return sendJson(res, 502, { error: `Request failed: ${why}` });
}

/** Stream an upstream body to the client with a byte cap; tear both down on overflow. */
function pipeCapped(up, res, limit) {
  let seen = 0;
  up.on("data", (chunk) => {
    seen += chunk.length;
    if (seen > limit) {
      up.destroy();
      res.destroy();
      return;
    }
    if (!res.write(chunk)) {
      up.pause();
      res.once("drain", () => up.resume());
    }
  });
  up.on("end", () => {
    // Fewer bytes than announced = a truncated transfer; never pass it off as complete.
    const declared = Number(up.headers["content-length"]);
    if (Number.isFinite(declared) && !up.headers["content-encoding"] && seen !== declared) res.destroy();
    else res.end();
  });
  up.on("error", () => res.destroy());
  up.on("close", () => {
    if (!up.complete) res.destroy();
  });
}

// ── app ─────────────────────────────────────────────────────────────────────

export function createApp({ config, log, jobs, engine, prober, fetcher }) {
  const keyIdOf = (req) => {
    const v = String(headerValue(req, "x-convertx-key-id") || "");
    return /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : "unknown";
  };
  const clientIpOf = (req) => {
    const v = String(headerValue(req, "x-convertx-client-ip") || "");
    return v.length <= 64 && /^[0-9a-fA-F:.]+$/.test(v) ? v : null;
  };
  // Every configured key is compared (no early exit), so timing says nothing
  // about which one matched.
  const authorized = (req) => {
    const presented = String(headerValue(req, "x-convertx-origin-key") || "");
    let ok = false;
    for (const k of config.originKeys) ok = safeEqual(presented, k) || ok;
    return ok && presented !== "";
  };

  // ── handlers ──

  async function health(_req, res) {
    sendJson(res, 200, { ok: true, service: "convertx-api", ytdlp: engine.version, ...jobs.stats() });
  }

  async function probe(req, res) {
    const body = await readJson(req);
    const ac = abortOnClose(req, res);
    const result = await prober.probe(body.url, { signal: ac.signal });
    sendJson(res, 200, result);
  }

  async function httpProxy(req, res) {
    const body = await readJson(req);
    const url = validateHttpUrl(body.url);
    const method = String(body.method || "GET").toUpperCase();
    if (!HTTP_METHODS.has(method)) throw new HttpError(400, "Only GET, HEAD and POST are supported");
    const headers = cleanRequestHeaders(body.headers);
    if (body.body != null && typeof body.body !== "string") throw new HttpError(400, "body must be a string");
    if (typeof body.body === "string" && Buffer.byteLength(body.body) > JSON_LIMIT) {
      throw new HttpError(413, "Request body too large");
    }
    const t = Number(body.timeoutMs);
    const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(Math.max(Math.round(t), 1000), 60_000) : 15_000;

    // Overall deadline like reqwest's Client::timeout: connect + headers + body.
    const ac = abortOnClose(req, res);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    try {
      const { res: up } = await fetcher.open(url, {
        method,
        headers,
        body: body.body ?? null,
        allowHost: isProxyAllowedHost,
        idleTimeoutMs: timeoutMs,
        signal: ac.signal,
      });
      const buf = method === "HEAD" ? Buffer.alloc(0) : await readBody(up, HTTP_BODY_LIMIT);
      up.destroy();
      sendJson(res, 200, {
        status: up.statusCode,
        body: decodeText(buf, up.headers["content-type"]),
        headers: joinRawHeaders(up.rawHeaders),
      });
    } catch (e) {
      if (timedOut) return sendJson(res, 504, { error: `Request timed out after ${timeoutMs}ms` });
      if (res.destroyed) return;
      log.info("http proxy failed", { url: redactUrl(url), detail: e.message });
      upstreamError(res, e);
    } finally {
      clearTimeout(timer);
    }
  }

  async function streamUpstream(req, res, { url, allowHost, limit, idleTimeoutMs, onOk }) {
    const ac = abortOnClose(req, res);
    let up;
    let finalUrl;
    try {
      ({ res: up, url: finalUrl } = await fetcher.open(url, {
        method: req.method === "HEAD" ? "HEAD" : "GET",
        allowHost,
        idleTimeoutMs,
        signal: ac.signal,
      }));
    } catch (e) {
      if (!res.destroyed) upstreamError(res, e);
      return;
    }
    const status = up.statusCode || 502;
    if (status < 200 || status > 299) {
      up.destroy();
      // Status passthrough. X-Upstream-Status tells "the CDN said 404" apart
      // from this service's own errors, which carry no such header.
      return sendJson(res, status, { error: `Upstream returned HTTP ${status}` }, {
        "x-upstream-status": String(status),
      });
    }
    const declared = Number(up.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      up.destroy();
      return sendJson(res, 413, { error: `File is larger than ${limit} bytes` });
    }
    const extra = onOk(up);
    if (extra instanceof HttpError) {
      up.destroy();
      return sendJson(res, extra.status, { error: extra.message });
    }
    const headers = {
      "content-type": up.headers["content-type"] || "application/octet-stream",
      "x-upstream-status": String(status),
      "x-final-url": finalUrl,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    };
    if (up.headers["content-encoding"]) headers["content-encoding"] = up.headers["content-encoding"];
    else if (Number.isFinite(declared)) headers["content-length"] = String(declared);
    res.writeHead(status, headers);
    if (req.method === "HEAD") {
      up.destroy();
      res.end();
      return;
    }
    pipeCapped(up, res, limit);
  }

  async function direct(req, res, url) {
    const target = validateHttpUrl(url.searchParams.get("url"));
    const fallbackName = (() => {
      try {
        return decodeURIComponent(path.posix.basename(new URL(target).pathname)) || "download";
      } catch {
        return "download";
      }
    })();
    const name = sanitizeFileName(url.searchParams.get("name") || fallbackName);
    await streamUpstream(req, res, {
      url: target,
      allowHost: isProxyAllowedHost,
      limit: config.maxFilesizeBytes,
      idleTimeoutMs: 60_000,
      onOk: (up) => {
        if (up.headers["content-length"] === "0") return new HttpError(502, "Download produced no data (0 bytes).");
        return { "content-disposition": contentDisposition(name) };
      },
    });
  }

  async function image(req, res, url) {
    const target = validateHttpUrl(url.searchParams.get("url"));
    await streamUpstream(req, res, {
      url: target,
      allowHost: null,
      limit: IMAGE_LIMIT,
      idleTimeoutMs: 20_000,
      onOk: (up) => {
        const type = String(up.headers["content-type"] || "").toLowerCase();
        if (!type.startsWith("image/")) return new HttpError(415, "That URL is not an image");
        return { "cache-control": "private, max-age=3600" };
      },
    });
  }

  async function createJob(req, res) {
    const body = await readJson(req);
    const job = jobs.create(body, { keyId: keyIdOf(req), clientIp: clientIpOf(req) });
    sendJson(res, 202, { jobId: job.id, token: job.token });
  }

  async function getJob(_req, res, id) {
    const job = jobs.get(id);
    if (!job) throw new HttpError(404, "Job not found — it may have expired");
    sendJson(res, 200, jobs.view(job));
  }

  async function deleteJob(_req, res, id) {
    const v = await jobs.cancel(id);
    if (!v) throw new HttpError(404, "Job not found — it may have expired");
    sendJson(res, 200, v);
  }

  async function jobFile(req, res, id, url) {
    const job = jobs.get(id);
    // Unknown job and wrong token look identical: no probing for job ids.
    if (!job || !jobs.tokenMatches(job, url.searchParams.get("t") || "")) {
      throw new HttpError(404, "File not found — it may have expired");
    }
    if (job.state !== "done") throw new HttpError(409, "The file isn't ready yet");
    let st;
    try {
      st = fs.statSync(job.filePath);
    } catch {
      throw new HttpError(410, "This download has expired");
    }
    const size = st.size;
    const base = {
      "content-type": mimeFor(job.filePath),
      "content-disposition": contentDisposition(job.fileName),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };

    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = headerValue(req, "range");
    if (range && size > 0) {
      const m = String(range).match(/^bytes=(\d*)-(\d*)$/);
      if (!m || (m[1] === "" && m[2] === "")) {
        res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      if (m[1] === "") {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
      }
      if (start > end || start >= size) {
        res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      status = 206;
      base["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    res.writeHead(status, { ...base, "content-length": String(size === 0 ? 0 : end - start + 1) });
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(job.filePath, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  async function engineUpdate(_req, res) {
    try {
      sendJson(res, 200, await engine.update());
    } catch (e) {
      log.error("yt-dlp update failed", { detail: e.message });
      sendJson(res, 500, { error: e.message });
    }
  }

  // ── router ──

  function route(method, pathname) {
    if (pathname === "/health") return method === "GET" || method === "HEAD" ? ["health", health] : ["405"];
    if (pathname === "/probe") return method === "POST" ? ["probe", probe, true] : ["405"];
    if (pathname === "/http") return method === "POST" ? ["http", httpProxy, true] : ["405"];
    if (pathname === "/direct") return method === "GET" || method === "HEAD" ? ["direct", direct, true] : ["405"];
    if (pathname === "/image") return method === "GET" || method === "HEAD" ? ["image", image, true] : ["405"];
    if (pathname === "/jobs") return method === "POST" ? ["jobs.create", createJob, true] : ["405"];
    if (pathname === "/engine/update") return method === "POST" ? ["engine.update", engineUpdate, true] : ["405"];
    let m = pathname.match(/^\/jobs\/([^/]+)\/file$/);
    if (m) return method === "GET" || method === "HEAD" ? ["jobs.file", jobFile, false, m[1]] : ["405"];
    m = pathname.match(/^\/jobs\/([^/]+)$/);
    if (m) {
      if (method === "GET") return ["jobs.get", getJob, true, m[1]];
      if (method === "DELETE") return ["jobs.delete", deleteJob, true, m[1]];
      return ["405"];
    }
    return null;
  }

  return async function handler(req, res) {
    const started = Date.now();
    let routeName = "unknown";
    res.on("finish", () => {
      if (routeName === "health") return;
      log.info("request", {
        method: req.method,
        route: routeName,
        status: res.statusCode,
        ms: Date.now() - started,
        keyId: keyIdOf(req),
        ip: clientIpOf(req) ?? undefined,
      });
    });
    try {
      let url;
      try {
        url = new URL(req.url, "http://convertx-api");
      } catch {
        throw new HttpError(400, "Bad request");
      }
      const hit = route(req.method, url.pathname);
      const publicRoute = hit && (hit[0] === "health" || hit[0] === "jobs.file");
      if (!publicRoute && !authorized(req)) throw new HttpError(401, "Unauthorized");
      if (!hit) throw new HttpError(404, "Not found");
      if (hit[0] === "405") throw new HttpError(405, "Method not allowed");
      routeName = hit[0];
      const [, fn, , param] = hit;
      if (param !== undefined && !JOB_ID_RE.test(param)) throw new HttpError(404, "Job not found — it may have expired");
      await fn(req, res, param !== undefined ? param : url, url);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 499) {
          res.destroy();
          return;
        }
        sendJson(res, e.status, { error: e.message }, e.headers);
        return;
      }
      log.error("unhandled error", { route: routeName, detail: e?.stack || String(e) });
      sendJson(res, 500, { error: "Internal error" });
    }
  };
}
