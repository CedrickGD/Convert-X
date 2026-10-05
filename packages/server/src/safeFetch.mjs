// The server's own outbound HTTP (/http, /direct, /image).
//
// Nothing here opens a socket to a destination. Every request goes through
// the egress proxy — the same one yt-dlp uses, which in production is the
// separate `egress` container (the API's own network has no route out):
//   - https: CONNECT host:port, then TLS over the tunnel with SNI and
//     certificate verification against the real host name;
//   - http: an absolute-URI request to the proxy.
// The proxy resolves, classifies (ipguard) and pins every destination — the
// single place where "is this address public?" is decided. Its refusals come
// back marked (x-convertx-egress) and are turned into EgressBlockedError.
//
// What stays here is per-request policy: http/https only, ports from the
// allowlist (80/443), no userinfo, the optional host allowlist, and manual
// redirects (max 5), each Location re-validated from scratch; https → http
// downgrades are refused and credentials are dropped when the host changes.

import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import {
  EGRESS_DETAIL_HEADER,
  EGRESS_HEADER,
  EGRESS_REASON_HEADER,
  proxyAuthHeader,
} from "./egressProxy.mjs";
import { EgressBlockedError } from "./ipguard.mjs";

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_ON_CROSS_HOST = ["authorization", "cookie", "proxy-authorization"];
// Failing to reach the proxy itself (not the destination behind it).
const PROXY_DOWN = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export class UpstreamError extends Error {
  constructor(message, code = "UPSTREAM") {
    super(message);
    this.name = "UpstreamError";
    this.code = code;
  }
}

export class TooLargeError extends Error {
  constructor(limit) {
    super(`Response is larger than ${limit} bytes`);
    this.name = "TooLargeError";
    this.code = "TOO_LARGE";
  }
}

/** One of the proxy's own answers → the error it stands for. */
function proxyFailure(headers, status, target) {
  const kind = String(headers[EGRESS_HEADER] || "");
  const reason = String(headers[EGRESS_REASON_HEADER] || "");
  const detail = String(headers[EGRESS_DETAIL_HEADER] || "");
  switch (kind) {
    case "blocked":
      return new EgressBlockedError(detail || `Blocked destination ${target}`, reason || "blocked");
    case "auth":
      return new UpstreamError(
        "The egress proxy refused this service: EGRESS_TOKEN differs between api and egress",
        "EGRESS_AUTH",
      );
    case "timeout":
      return new UpstreamError(detail || `Timed out connecting to ${target}`, "STALLED");
    case "unresolved":
    case "unreachable": {
      const e = new Error(detail || `Could not reach ${target}`);
      e.code = reason || (kind === "unresolved" ? "ENOTFOUND" : "UPSTREAM");
      return e;
    }
    default:
      return new UpstreamError(
        `The egress proxy answered HTTP ${status}${detail ? `: ${detail}` : ""}`,
        "EGRESS_PROXY",
      );
  }
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  e.code = "ABORT_ERR";
  return e;
}

/**
 * `proxy` = {host, port, token?}: the egress proxy (required — there is no
 * direct mode). `tls` is extra options for the TLS handshake (tests pass a
 * private CA; the service itself uses the system trust store).
 */
export function createSafeFetcher({ proxy, allowedPorts = [80, 443], maxRedirects = 5, tls: tlsExtra = null } = {}) {
  if (!proxy || !proxy.host || !proxy.port) {
    throw new Error("createSafeFetcher needs the egress proxy as {host, port}");
  }
  const authHeader = proxy.token ? { "proxy-authorization": proxyAuthHeader(proxy.token) } : {};

  function checkUrl(u, allowHost) {
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new EgressBlockedError("Only http and https URLs are allowed", "scheme");
    }
    if (u.username || u.password) {
      throw new EgressBlockedError("URLs with credentials are not allowed", "userinfo");
    }
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (!allowedPorts.includes(port)) {
      throw new EgressBlockedError(`Port ${port} is not allowed`, "port");
    }
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (allowHost && !allowHost(host)) {
      throw new EgressBlockedError(`${host} is not on the allowed host list`, "host");
    }
    return port;
  }

  function proxyDown(e, signal) {
    if (signal?.aborted) return abortError(signal);
    if (PROXY_DOWN.has(e?.code)) {
      return new UpstreamError(
        `Can't reach the egress proxy at ${proxy.host}:${proxy.port} (${e.code})`,
        "EGRESS_DOWN",
      );
    }
    return e;
  }

  /** CONNECT through the proxy, then TLS to the real host (SNI + cert check). */
  function openTunnel(host, port, { idleTimeoutMs, signal }) {
    const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let secure = null;
      let timer = null;
      let req = null;
      const onAbort = () => settle(abortError(signal));
      function settle(err, sock) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (err) {
          req?.destroy();
          secure?.destroy();
          reject(err);
        } else {
          resolve(sock);
        }
      }
      if (signal?.aborted) return settle(abortError(signal));
      signal?.addEventListener("abort", onAbort, { once: true });

      req = http.request({
        host: proxy.host,
        port: proxy.port,
        method: "CONNECT",
        path: authority,
        headers: { host: authority, ...authHeader },
        agent: false,
      });
      if (idleTimeoutMs > 0) {
        timer = setTimeout(() => {
          settle(new UpstreamError(`No response for ${Math.round(idleTimeoutMs / 1000)}s`, "STALLED"));
        }, idleTimeoutMs);
      }
      req.on("connect", (res, socket, head) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return settle(proxyFailure(res.headers, res.statusCode, authority));
        }
        if (settled) return socket.destroy();
        if (head && head.length) socket.unshift(head);
        secure = tls.connect({
          ...(tlsExtra || {}),
          socket,
          // checkServerIdentity runs against `host`; SNI only for names
          // (RFC 6066 forbids IP literals there).
          host,
          servername: net.isIP(host) ? undefined : host,
          ALPNProtocols: ["http/1.1"],
          rejectUnauthorized: true,
        });
        secure.once("secureConnect", () => settle(null, secure));
        secure.once("error", (e) => settle(e));
      });
      req.on("error", (e) => settle(proxyDown(e, signal)));
      req.end();
    });
  }

  /** Issue the request; `viaProxy` = the answer may be one of the proxy's own. */
  function send(options, { body, idleTimeoutMs, signal, viaProxy, target, socket }) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = http.request({ ...options, signal });
      } catch (e) {
        socket?.destroy();
        reject(e);
        return;
      }
      if (idleTimeoutMs > 0) {
        req.setTimeout(idleTimeoutMs, () => {
          req.destroy(new UpstreamError(`No response for ${Math.round(idleTimeoutMs / 1000)}s`, "STALLED"));
        });
      }
      req.on("response", (res) => {
        if (viaProxy && res.headers[EGRESS_HEADER]) {
          res.resume();
          reject(proxyFailure(res.headers, res.statusCode, target));
          return;
        }
        // A tunnel serves exactly one request: close it (and the proxy's
        // upstream leg) as soon as the response is done or abandoned.
        if (socket) res.once("close", () => socket.destroy());
        resolve(res);
      });
      req.on("error", (e) => reject(viaProxy ? proxyDown(e, signal) : e));
      if (body != null && options.method !== "GET" && options.method !== "HEAD") req.end(body);
      else req.end();
    });
  }

  async function requestOnce(u, port, { method, headers, body, idleTimeoutMs, signal }) {
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (u.protocol === "http:") {
      return send(
        {
          host: proxy.host,
          port: proxy.port,
          method,
          path: `http://${u.host}${u.pathname}${u.search}`,
          headers: { host: u.host, ...headers, ...authHeader },
          agent: false,
        },
        { body, idleTimeoutMs, signal, viaProxy: true, target: `${host}:${port}` },
      );
    }
    const socket = await openTunnel(host, port, { idleTimeoutMs, signal });
    return send(
      {
        createConnection: () => socket,
        method,
        path: `${u.pathname}${u.search}`,
        headers: { host: u.host, ...headers, connection: "close" },
      },
      { body, idleTimeoutMs, signal, viaProxy: false, socket },
    );
  }

  /**
   * Open a request through the egress proxy and follow redirects. Resolves
   * to `{res, url}` where `res` is the final IncomingMessage (caller
   * consumes or destroys it) and `url` the final URL. Rejects with
   * EgressBlockedError / UpstreamError / network or TLS errors.
   */
  async function open(
    rawUrl,
    { method = "GET", headers = {}, body = null, allowHost = null, idleTimeoutMs = 60_000, signal } = {},
  ) {
    let current;
    try {
      current = new URL(rawUrl);
    } catch {
      throw new EgressBlockedError("Not a valid URL", "invalid");
    }
    let m = String(method).toUpperCase();
    let b = body;
    let hdrs = { ...headers };

    for (let hop = 0; ; hop++) {
      const port = checkUrl(current, allowHost);
      if (signal?.aborted) throw abortError(signal);
      const res = await requestOnce(current, port, { method: m, headers: hdrs, body: b, idleTimeoutMs, signal });

      const loc = res.headers.location;
      if (!REDIRECTS.has(res.statusCode) || !loc) return { res, url: current.href };
      res.destroy();
      if (hop >= maxRedirects) throw new UpstreamError(`Too many redirects (over ${maxRedirects})`, "REDIRECTS");

      let next;
      try {
        next = new URL(loc, current);
      } catch {
        throw new UpstreamError("Redirect to an invalid URL", "REDIRECT_INVALID");
      }
      if (current.protocol === "https:" && next.protocol === "http:") {
        throw new EgressBlockedError("Refusing to follow a redirect from https to http", "downgrade");
      }
      if (res.statusCode === 303 ? m !== "HEAD" : (res.statusCode === 301 || res.statusCode === 302) && m === "POST") {
        m = "GET";
        b = null;
        hdrs = Object.fromEntries(Object.entries(hdrs).filter(([k]) => !/^content-(type|length)$/i.test(k)));
      }
      if (next.host !== current.host) {
        hdrs = Object.fromEntries(
          Object.entries(hdrs).filter(([k]) => !SENSITIVE_ON_CROSS_HOST.includes(k.toLowerCase())),
        );
      }
      current = next;
    }
  }

  return { open };
}

/** Decode a response body stream according to Content-Encoding. */
export function decodedStream(res) {
  const enc = String(res.headers["content-encoding"] || "").trim().toLowerCase();
  if (enc === "gzip" || enc === "x-gzip") return res.pipe(zlib.createGunzip());
  if (enc === "deflate") return res.pipe(zlib.createInflate());
  if (enc === "br") return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/** Read a whole (decoded) body, failing past `maxBytes`. */
export function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const stream = decodedStream(res);
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        res.destroy();
        stream.destroy();
        reject(new TooLargeError(maxBytes));
        return;
      }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    res.on("close", () => {
      if (!res.complete) reject(new UpstreamError("Connection closed before the response finished", "ABORTED"));
    });
    res.on("error", reject);
  });
}

/** Response headers as the Rust payload has them: lowercased, repeats joined ", ". */
export function joinRawHeaders(rawHeaders) {
  const out = {};
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const k = rawHeaders[i].toLowerCase();
    out[k] = k in out ? `${out[k]}, ${rawHeaders[i + 1]}` : rawHeaders[i + 1];
  }
  return out;
}

/** Text the way reqwest's Response::text() decodes it (charset, lossy). */
export function decodeText(buf, contentType) {
  const m = String(contentType || "").match(/charset\s*=\s*"?([^";\s]+)"?/i);
  const label = m ? m[1].toLowerCase() : "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

// ── host allowlists ─────────────────────────────────────────────────────────

const SUFFIXES = [
  "twimg.com", // cdn.syndication.twimg.com, pbs/video/abs.twimg.com
  "instagram.com",
  "cdninstagram.com",
  "fbcdn.net",
  "tenor.com",
  "giphy.com",
];
const EXACT = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "images-ext-1.discordapp.net",
  "images-ext-2.discordapp.net",
]);

/** The /http and /direct host allowlist (what the shared probers need). */
export function isProxyAllowedHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h || h.includes(":")) return false;
  if (EXACT.has(h)) return true;
  if (/^static\d*\.klipy\.com$/.test(h)) return true;
  return SUFFIXES.some((d) => h === d || h.endsWith(`.${d}`));
}
