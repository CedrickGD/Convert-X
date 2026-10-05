// The forward proxy every outbound byte of convertx-api goes through: yt-dlp
// (--proxy), the helpers it spawns (ffmpeg, pip via HTTP(S)_PROXY) and the
// API's own fetches (safeFetch tunnels through it too).
//
// In production it runs alone in the `egress` container (src/egressMain.mjs),
// the only container with a route out; the API container sits on an internal
// network and can reach nothing but this proxy and cloudflared. In dev
// (EGRESS_MODE=inprocess) the API starts it on 127.0.0.1 itself.
//
// yt-dlp follows whatever URLs a page or manifest hands it, so the guard has
// to sit on the wire, not on the URL the user pasted. For each CONNECT
// (https) or absolute-URI request (plain http) the proxy resolves the host
// once, refuses if ANY answer is non-public, and connects to exactly the
// vetted addresses — a DNS answer can't change between check and connect.
// This is the single place where destinations are classified.
//
// Only proxy-form requests are served (CONNECT authority / absolute URI);
// with EGRESS_TOKEN set, only clients presenting it (Proxy-Authorization:
// Basic, any user name, the token as password) get anywhere.

import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { EgressBlockedError, pinnedLookup } from "./ipguard.mjs";

/**
 * Reason phrase on every refusal. yt-dlp quotes it in its error ("HTTP Error
 * 403: …" / "Tunnel connection failed: 403 …"), which lets the job runner
 * tell a policy block apart from a site's own 403.
 */
export const EGRESS_REFUSAL = "Blocked by Convert-X egress policy";

/**
 * Set on every answer the proxy writes itself (refusals, auth challenges,
 * its own 502/504s) and stripped from upstream responses, so a client can
 * tell "the proxy said no" from "the site said no" for plain-http requests.
 * Value: blocked | auth | unresolved | unreachable | timeout | bad-request.
 */
export const EGRESS_HEADER = "x-convertx-egress";
export const EGRESS_REASON_HEADER = "x-convertx-egress-reason";
export const EGRESS_DETAIL_HEADER = "x-convertx-egress-detail";

const AUTH_REALM = 'Basic realm="convertx-egress"';
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function stripHopByHop(headers) {
  const out = {};
  const listed = String(headers.connection || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || listed.includes(key)) continue;
    out[k] = v;
  }
  return out;
}

/** Upstream must never be able to fake one of the proxy's own answers. */
function stripEgressHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k.toLowerCase().startsWith(EGRESS_HEADER)) out[k] = v;
  }
  return out;
}

const headerSafe = (v) => String(v ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 300);

function marker(kind, reason = "", detail = "") {
  const h = { [EGRESS_HEADER]: kind };
  if (reason) h[EGRESS_REASON_HEADER] = headerSafe(reason);
  if (detail) h[EGRESS_DETAIL_HEADER] = headerSafe(detail);
  return h;
}

/** Proxy-Authorization: Basic base64(<any user>:<token>), compared in constant time. */
export function proxyAuthMatches(headerValue, token) {
  const m = String(headerValue || "").match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i);
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const presented = decoded.slice(colon + 1);
  const a = crypto.createHash("sha256").update(presented).digest();
  const b = crypto.createHash("sha256").update(String(token)).digest();
  return crypto.timingSafeEqual(a, b) && presented.length === String(token).length;
}

/** The header a client sends for `token`. */
export function proxyAuthHeader(token) {
  return `Basic ${Buffer.from(`convertx:${token}`).toString("base64")}`;
}

/** "host:port" / "[v6]:port" → {host, port} | null */
export function parseAuthority(authority) {
  const s = String(authority || "");
  const m = s.match(/^\[([^\]]+)\]:(\d{1,5})$/) || s.match(/^([^:[\]]+):(\d{1,5})$/);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1].toLowerCase(), port };
}

function timeoutError(target) {
  const e = new Error(`Timed out connecting to ${target}`);
  e.code = "ETIMEDOUT";
  return e;
}

export function createEgressProxy({
  guard,
  allowedPorts = [80, 443, 8080, 8443],
  token = "",
  log,
  connectTimeoutMs = 15_000,
  idleTimeoutMs = 5 * 60_000,
}) {
  const sockets = new Set();

  function blocked(kind, target, err) {
    log?.warn("egress blocked", { kind, target, reason: err.reason || err.code || "error", detail: err.message });
  }

  /** null when the client may use the proxy, else the refusal to send. */
  function authFailure(req, kind) {
    if (!token) return null;
    const presented = req.headers["proxy-authorization"];
    if (proxyAuthMatches(presented, token)) return null;
    // A missing header is the normal first round of ffmpeg's challenge
    // flow; a wrong one is worth a warning.
    const fields = { kind, from: req.socket?.remoteAddress };
    if (presented) log?.warn("egress auth failed", fields);
    else log?.debug("egress auth required", fields);
    return { "proxy-authenticate": AUTH_REALM, ...marker("auth") };
  }

  async function vet(host, port) {
    if (!allowedPorts.includes(port)) throw new EgressBlockedError(`Port ${port} is not allowed`, "port");
    return guard.resolvePublic(host);
  }

  function rejectSocket(socket, status, text, headers = {}) {
    if (socket.destroyed) return;
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    socket.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  }

  async function onConnect(req, client, head) {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    const denied = authFailure(req, "CONNECT");
    if (denied) return rejectSocket(client, 407, "Proxy Authentication Required", denied);
    const target = parseAuthority(req.url);
    if (!target) return rejectSocket(client, 400, "Bad Request", marker("bad-request", "authority"));
    const label = `${target.host}:${target.port}`;

    let vetted;
    try {
      vetted = await vet(target.host, target.port);
    } catch (e) {
      if (e instanceof EgressBlockedError) {
        blocked("CONNECT", label, e);
        return rejectSocket(client, 403, EGRESS_REFUSAL, marker("blocked", e.reason, e.message));
      }
      return rejectSocket(client, 502, "Bad Gateway", marker("unresolved", e.code || "ENOTFOUND", e.message));
    }
    if (client.destroyed) return;

    const upstream = net.connect({
      host: target.host,
      port: target.port,
      lookup: pinnedLookup(vetted),
      autoSelectFamily: true,
    });
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    let connected = false;
    upstream.setTimeout(connectTimeoutMs, () => {
      if (!connected) {
        upstream.destroy();
        rejectSocket(client, 504, "Gateway Timeout", marker("timeout", "ETIMEDOUT", timeoutError(label).message));
      }
    });
    upstream.on("connect", () => {
      connected = true;
      log?.debug("egress allowed", { kind: "CONNECT", target: label });
      upstream.setTimeout(idleTimeoutMs, () => {
        upstream.destroy();
        client.destroy();
      });
      client.setTimeout(idleTimeoutMs, () => {
        upstream.destroy();
        client.destroy();
      });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", (e) => {
      if (!connected) rejectSocket(client, 502, "Bad Gateway", marker("unreachable", e.code || "", e.message));
      else client.destroy();
    });
    client.on("close", () => upstream.destroy());
  }

  async function onRequest(req, res) {
    const plain = (status, kind, reason, text, extra = {}) => {
      res.writeHead(status, { "content-type": "text/plain", ...marker(kind, reason, text), ...extra }).end(text);
    };
    const denied = authFailure(req, req.method);
    if (denied) {
      res.writeHead(407, { "content-type": "text/plain", ...denied }).end("Proxy authentication required");
      return;
    }
    let u;
    try {
      u = new URL(req.url);
    } catch {
      return plain(400, "bad-request", "origin-form", "This is a forward proxy");
    }
    if (u.protocol !== "http:") return plain(400, "bad-request", "scheme", "Use CONNECT for https");
    if (!ALLOWED_METHODS.has(req.method)) {
      return plain(405, "bad-request", "method", "Method not allowed", { allow: [...ALLOWED_METHODS].join(", ") });
    }
    if (u.username || u.password) return plain(400, "bad-request", "userinfo", "URLs with credentials are not allowed");
    const port = u.port ? Number(u.port) : 80;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const label = `${host}:${port}`;
    let vetted;
    try {
      vetted = await vet(host, port);
    } catch (e) {
      if (e instanceof EgressBlockedError) {
        blocked(req.method, label, e);
        res
          .writeHead(403, EGRESS_REFUSAL, { "content-type": "text/plain", ...marker("blocked", e.reason, e.message) })
          .end(EGRESS_REFUSAL);
      } else {
        plain(502, "unresolved", e.code || "ENOTFOUND", "Could not resolve destination");
      }
      return;
    }

    const headers = stripHopByHop(req.headers);
    const upstream = http.request({
      hostname: host,
      port,
      path: `${u.pathname}${u.search}`,
      method: req.method,
      headers: { ...headers, host: u.host },
      lookup: pinnedLookup(vetted),
      agent: false,
    });
    const connectTimer = setTimeout(() => upstream.destroy(timeoutError(label)), connectTimeoutMs);
    upstream.on("socket", (s) => {
      if (!s.connecting) clearTimeout(connectTimer);
      else s.once("connect", () => clearTimeout(connectTimer));
    });
    upstream.setTimeout(idleTimeoutMs, () => upstream.destroy(timeoutError(label)));
    upstream.on("response", (up) => {
      clearTimeout(connectTimer);
      log?.debug("egress allowed", { kind: req.method, target: label });
      res.writeHead(up.statusCode || 502, stripEgressHeaders(stripHopByHop(up.headers)));
      up.pipe(res);
      up.on("error", () => res.destroy());
    });
    upstream.on("error", (e) => {
      clearTimeout(connectTimer);
      if (res.headersSent) return res.destroy();
      if (e.code === "ETIMEDOUT") plain(504, "timeout", "ETIMEDOUT", e.message);
      else plain(502, "unreachable", e.code || "", `Bad Gateway: ${e.message}`);
    });
    // The client went away (req's own 'close' fires once a body is read, so
    // watch the response side).
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    if (req.method === "POST") req.pipe(upstream);
    else upstream.end();
  }

  const server = http.createServer(onRequest);
  server.on("connect", (req, socket, head) => {
    onConnect(req, socket, head).catch(() => socket.destroy());
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  return {
    server,
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
