import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import {
  EGRESS_REFUSAL,
  createEgressProxy,
  parseAuthority,
  proxyAuthHeader,
  proxyAuthMatches,
} from "../src/egressProxy.mjs";
import { startEgress } from "../src/egressServer.mjs";
import { silentLogger } from "../src/log.mjs";
import { startProxy, startServer, testGuard } from "./helpers.mjs";

/** Raw CONNECT; resolves with the status code, status line, headers and the open socket. */
function connect(proxyPort, authority, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, "127.0.0.1", () => {
      const extra = Object.entries(extraHeaders)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${extra}\r\n`);
    });
    let buf = "";
    const onData = (d) => {
      buf += d.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end >= 0) {
        s.off("data", onData);
        const lines = buf.slice(0, end).split("\r\n");
        const headers = Object.fromEntries(
          lines.slice(1).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]),
        );
        resolve({ status: Number(buf.split(" ")[1]), line: lines[0], headers, socket: s });
      }
    };
    s.on("data", onData);
    s.on("error", reject);
  });
}

/** Speak HTTP/1.1 over an established tunnel. */
function getOverTunnel(socket, host, path) {
  return new Promise((resolve, reject) => {
    let buf = "";
    socket.on("data", (d) => (buf += d.toString("utf8")));
    socket.on("end", () => resolve(buf));
    socket.on("error", reject);
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
  });
}

function proxyGet(proxyPort, absoluteUrl, method = "GET", { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method, path: absoluteUrl, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, body: text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

describe("egress proxy", () => {
  let origin;
  let proxy;
  let proxyPort;
  let calls;
  const blocked = [];

  before(async () => {
    origin = await startServer((req, res) => {
      res.setHeader("x-seen-host", req.headers.host || "");
      res.setHeader("x-seen-proxy-auth", req.headers["proxy-authorization"] || "none");
      // An upstream trying to pass for the proxy's own refusal.
      if (req.url.startsWith("/marker")) res.setHeader("x-convertx-egress", "blocked");
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.end(`origin:${req.method}:${req.url}${body ? `:${body}` : ""}`));
    });
    const g = testGuard({
      "tunnel.test": ["127.0.0.1"],
      "lan.test": ["192.168.2.201"],
      "mixed.test": ["127.0.0.1", "10.0.0.1"],
      "meta.test": ["169.254.169.254"],
    });
    calls = g.calls;
    proxy = createEgressProxy({
      guard: g.guard,
      allowedPorts: [origin.port],
      log: { warn: (msg, f) => blocked.push(f), info() {}, error() {}, debug() {} },
    });
    proxyPort = (await proxy.listen(0)).port;
  });
  after(async () => {
    await proxy.close();
    await origin.close();
  });

  it("tunnels CONNECT to a vetted host, pinned to the vetted address", async () => {
    // tunnel.test is unknown to real DNS — the tunnel only works if the proxy
    // connected to the guard's answer.
    const { status, socket } = await connect(proxyPort, `tunnel.test:${origin.port}`);
    assert.equal(status, 200);
    const reply = await getOverTunnel(socket, "tunnel.test", "/via-tunnel");
    assert.match(reply, /^HTTP\/1\.1 200/);
    assert.match(reply, /origin:GET:\/via-tunnel/);
    assert.ok(calls.includes("tunnel.test"));
  });

  it("refuses CONNECT to private, link-local and mixed answers", async () => {
    for (const host of ["lan.test", "meta.test", "mixed.test"]) {
      const { status, line, socket } = await connect(proxyPort, `${host}:${origin.port}`);
      assert.equal(status, 403, host);
      // yt-dlp quotes this phrase; the job runner keys its message off it.
      assert.equal(line, `HTTP/1.1 403 ${EGRESS_REFUSAL}`);
      socket.destroy();
    }
    assert.ok(blocked.some((b) => b.target.startsWith("lan.test") && b.reason === "private"));
  });

  it("refuses CONNECT to IP literals in blocked ranges", async () => {
    for (const a of [`127.0.0.2:${origin.port}`, `[::1]:${origin.port}`, `10.1.2.3:${origin.port}`, `[::ffff:192.168.1.1]:${origin.port}`]) {
      const { status, socket } = await connect(proxyPort, a);
      assert.equal(status, 403, a);
      socket.destroy();
    }
  });

  it("refuses ports outside the allowlist and malformed authorities", async () => {
    const r1 = await connect(proxyPort, "tunnel.test:22");
    assert.equal(r1.status, 403);
    r1.socket.destroy();
    const r2 = await connect(proxyPort, "no-port-here");
    assert.equal(r2.status, 400);
    r2.socket.destroy();
  });

  it("answers 502 when a name does not resolve", async () => {
    const r = await connect(proxyPort, `nowhere.test:${origin.port}`);
    assert.equal(r.status, 502);
    r.socket.destroy();
  });

  it("forwards absolute-URI GET/HEAD for plain http", async () => {
    const r = await proxyGet(proxyPort, `http://tunnel.test:${origin.port}/plain?q=1`);
    assert.equal(r.status, 200);
    assert.equal(r.body, "origin:GET:/plain?q=1");
    assert.equal(r.headers["x-seen-host"], `tunnel.test:${origin.port}`);
    const h = await proxyGet(proxyPort, `http://tunnel.test:${origin.port}/plain`, "HEAD");
    assert.equal(h.status, 200);
  });

  it("refuses absolute-URI requests to blocked hosts, other methods and origin-form", async () => {
    assert.equal((await proxyGet(proxyPort, `http://lan.test:${origin.port}/`)).status, 403);
    assert.equal((await proxyGet(proxyPort, `http://tunnel.test:${origin.port}/`, "PUT")).status, 405);
    assert.equal((await proxyGet(proxyPort, "/not-a-proxy-request")).status, 400);
    assert.equal((await proxyGet(proxyPort, `http://127.0.0.1:${proxyPort}/`)).status, 403);
  });

  it("marks its own answers so clients can tell them from a site's", async () => {
    const c = await connect(proxyPort, `lan.test:${origin.port}`);
    assert.equal(c.headers["x-convertx-egress"], "blocked");
    assert.equal(c.headers["x-convertx-egress-reason"], "private");
    assert.match(c.headers["x-convertx-egress-detail"], /lan\.test.*private/);
    c.socket.destroy();
    const u = await connect(proxyPort, `nowhere.test:${origin.port}`);
    assert.equal(u.headers["x-convertx-egress"], "unresolved");
    assert.equal(u.headers["x-convertx-egress-reason"], "ENOTFOUND");
    u.socket.destroy();
    const g = await proxyGet(proxyPort, `http://meta.test:${origin.port}/`);
    assert.equal(g.status, 403);
    assert.equal(g.headers["x-convertx-egress"], "blocked");
    assert.equal(g.headers["x-convertx-egress-reason"], "link-local");
    const o = await proxyGet(proxyPort, "/origin-form");
    assert.equal(o.headers["x-convertx-egress"], "bad-request");
    // …and an upstream can't fake one: its marker header is dropped.
    const fake = await proxyGet(proxyPort, `http://tunnel.test:${origin.port}/marker`);
    assert.equal(fake.status, 200);
    assert.equal(fake.headers["x-convertx-egress"], undefined);
  });

  it("forwards absolute-URI POST bodies", async () => {
    const r = await proxyGet(proxyPort, `http://tunnel.test:${origin.port}/form`, "POST", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&b=2",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, "origin:POST:/form:a=1&b=2");
  });

  it("answers 502 'unreachable' when the vetted address refuses the connection", async () => {
    const closed = await startServer((_q, s) => s.end());
    const port = closed.port;
    await closed.close();
    const g = testGuard({ "down.test": ["127.0.0.1"] });
    const p = createEgressProxy({ guard: g.guard, allowedPorts: [port], log: silentLogger });
    const pp = (await p.listen(0)).port;
    try {
      const c = await connect(pp, `down.test:${port}`);
      assert.equal(c.status, 502);
      assert.equal(c.headers["x-convertx-egress"], "unreachable");
      assert.equal(c.headers["x-convertx-egress-reason"], "ECONNREFUSED");
      c.socket.destroy();
      const r = await proxyGet(pp, `http://down.test:${port}/`);
      assert.equal(r.status, 502);
      assert.equal(r.headers["x-convertx-egress"], "unreachable");
    } finally {
      await p.close();
    }
  });
});

describe("egress proxy with EGRESS_TOKEN", () => {
  const TOKEN = "egress-token-0123456789abcdef";
  let origin;
  let eg;

  before(async () => {
    origin = await startServer((req, res) => {
      res.setHeader("x-seen-proxy-auth", req.headers["proxy-authorization"] || "none");
      res.end(`origin:${req.method}:${req.url}`);
    });
    eg = await startProxy({ "tunnel.test": ["127.0.0.1"] }, { token: TOKEN, allowedPorts: [origin.port] });
  });
  after(async () => {
    await eg.close();
    await origin.close();
  });

  it("challenges a CONNECT without credentials (ffmpeg's first round) with 407 + Basic", async () => {
    const r = await connect(eg.port, `tunnel.test:${origin.port}`);
    assert.equal(r.status, 407);
    assert.equal(r.headers["proxy-authenticate"], 'Basic realm="convertx-egress"');
    assert.equal(r.headers["x-convertx-egress"], "auth");
    r.socket.destroy();
    assert.deepEqual(eg.calls, [], "an unauthenticated client gets no DNS lookups out of it");
    assert.equal(eg.authFailures.length, 0, "a missing header is not a warning");
  });

  it("refuses a wrong token, accepts the right one with any user name", async () => {
    const wrong = await connect(eg.port, `tunnel.test:${origin.port}`, {
      "Proxy-Authorization": proxyAuthHeader("not-the-token-0123456789"),
    });
    assert.equal(wrong.status, 407);
    wrong.socket.destroy();
    assert.equal(eg.authFailures.length, 1);

    const basic = `Basic ${Buffer.from(`yt-dlp:${TOKEN}`).toString("base64")}`;
    const ok = await connect(eg.port, `tunnel.test:${origin.port}`, { "Proxy-Authorization": basic });
    assert.equal(ok.status, 200);
    const reply = await getOverTunnel(ok.socket, "tunnel.test", "/tunnelled");
    assert.match(reply, /origin:GET:\/tunnelled/);
  });

  it("guards absolute-URI requests the same way and never forwards the credentials", async () => {
    const none = await proxyGet(eg.port, `http://tunnel.test:${origin.port}/x`);
    assert.equal(none.status, 407);
    assert.equal(none.headers["proxy-authenticate"], 'Basic realm="convertx-egress"');
    const ok = await proxyGet(eg.port, `http://tunnel.test:${origin.port}/x`, "GET", {
      headers: { "proxy-authorization": proxyAuthHeader(TOKEN) },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body, "origin:GET:/x");
    assert.equal(ok.headers["x-seen-proxy-auth"], "none");
  });

  it("proxyAuthMatches: Basic only, password must match exactly", () => {
    assert.equal(proxyAuthMatches(proxyAuthHeader(TOKEN), TOKEN), true);
    assert.equal(proxyAuthMatches(`basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`, TOKEN), true);
    assert.equal(proxyAuthMatches(proxyAuthHeader(`${TOKEN}x`), TOKEN), false);
    assert.equal(proxyAuthMatches(proxyAuthHeader(TOKEN.slice(1)), TOKEN), false);
    assert.equal(proxyAuthMatches(`Bearer ${TOKEN}`, TOKEN), false);
    assert.equal(proxyAuthMatches(`Basic ${Buffer.from(TOKEN).toString("base64")}`, TOKEN), false);
    assert.equal(proxyAuthMatches("", TOKEN), false);
    assert.equal(proxyAuthMatches(undefined, TOKEN), false);
  });
});

describe("egress container entry (startEgress)", () => {
  it("listens where EGRESS_* say and requires the token", async () => {
    const origin = await startServer((req, res) => res.end("ok"));
    const token = "egress-token-0123456789abcdef";
    // 127.0.0.1 here; the container uses the default 0.0.0.0 on its internal network.
    const eg = await startEgress({
      env: { EGRESS_LISTEN_HOST: "127.0.0.1", EGRESS_PROXY_PORT: "18897", EGRESS_TOKEN: token },
      log: silentLogger,
    });
    try {
      assert.equal(eg.address.address, "127.0.0.1");
      assert.equal(eg.address.port, 18897);
      assert.deepEqual(eg.config.allowedPorts, [80, 443, 8080, 8443]);
      const r = await connect(18897, `127.0.0.1:${origin.port}`);
      assert.equal(r.status, 407);
      r.socket.destroy();
      // With the token the real classifier answers: loopback is refused.
      const r2 = await connect(18897, `127.0.0.1:443`, { "Proxy-Authorization": proxyAuthHeader(token) });
      assert.equal(r2.status, 403);
      r2.socket.destroy();
    } finally {
      await eg.stop();
      await origin.close();
    }
  });

  it("refuses a malformed token at startup", async () => {
    await assert.rejects(startEgress({ env: { EGRESS_TOKEN: "short" }, log: silentLogger }), /EGRESS_TOKEN/);
    await assert.rejects(startEgress({ env: { EGRESS_TOKEN: "has spaces in it 0123456789" }, log: silentLogger }), /EGRESS_TOKEN/);
  });
});

describe("parseAuthority", () => {
  it("parses host:port and [v6]:port", () => {
    assert.deepEqual(parseAuthority("Example.com:443"), { host: "example.com", port: 443 });
    assert.deepEqual(parseAuthority("[2606:4700::1]:443"), { host: "2606:4700::1", port: 443 });
    assert.equal(parseAuthority("example.com"), null);
    assert.equal(parseAuthority("example.com:0"), null);
    assert.equal(parseAuthority("example.com:99999"), null);
    assert.equal(parseAuthority("a:b:443"), null);
  });
});
