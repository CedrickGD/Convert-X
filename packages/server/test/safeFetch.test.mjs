// safeFetch never connects to a destination itself: every request goes
// through a real egress proxy (test/helpers.mjs startProxy) whose DNS the test
// scripts. Host names like pinned.test exist only in that script, so a
// request that worked can only have gone through the proxy.

import assert from "node:assert/strict";
import tls from "node:tls";
import { after, before, describe, it } from "node:test";
import { EgressBlockedError } from "../src/ipguard.mjs";
import {
  UpstreamError,
  createSafeFetcher,
  decodeText,
  isProxyAllowedHost,
  joinRawHeaders,
  readBody,
} from "../src/safeFetch.mjs";
import { deadPort, fixture, startProxy, startServer, waitFor } from "./helpers.mjs";

const drain = async (res) => (await readBody(res, 1 << 20)).toString("utf8");
const CA = fixture("test-tls.crt");

describe("safe fetcher (through the egress proxy)", () => {
  let srv;
  let tlsSrv;
  const hits = [];
  const tlsHits = [];
  const proxies = [];

  before(async () => {
    srv = await startServer((req, res) => {
      hits.push({ url: req.url, host: req.headers.host, method: req.method, cookie: req.headers.cookie });
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/ok") return res.end("hello");
      if (u.pathname === "/to") {
        res.writeHead(Number(u.searchParams.get("code") || 302), { location: u.searchParams.get("loc") });
        return res.end();
      }
      if (u.pathname === "/echo-method") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => res.end(`${req.method}:${body}`));
        return;
      }
      if (u.pathname === "/loop") {
        res.writeHead(302, { location: "/loop" });
        return res.end();
      }
      if (u.pathname === "/fake-marker") {
        // An upstream pretending to be the proxy's refusal.
        res.writeHead(403, { "x-convertx-egress": "blocked", "x-convertx-egress-reason": "private" });
        return res.end("site says no");
      }
      res.writeHead(404).end("nope");
    });
    tlsSrv = await startServer(
      (req, res) => {
        // servername = the SNI the client sent (false when it sent none).
        tlsHits.push({ sni: req.socket.servername, host: req.headers.host, url: req.url });
        const u = new URL(req.url, "https://x");
        if (u.pathname === "/down") {
          res.writeHead(302, { location: `http://plain.test:${srv.port}/ok` });
          return res.end();
        }
        res.end("secure");
      },
      { tls: true },
    );
  });
  after(async () => {
    for (const p of proxies) await p.close();
    await srv.close();
    await tlsSrv.close();
  });

  const fetcherFor = async (answers, { proxyToken = "", fetcherToken = proxyToken, ca = CA } = {}) => {
    const eg = await startProxy(answers, { token: proxyToken, allowedPorts: [srv.port, tlsSrv.port] });
    proxies.push(eg);
    const fetcher = createSafeFetcher({
      proxy: { host: "127.0.0.1", port: eg.port, token: fetcherToken },
      allowedPorts: [srv.port, tlsSrv.port],
      tls: ca ? { ca } : null,
    });
    return { fetcher, eg, calls: eg.calls };
  };

  it("sends plain http as an absolute-URI request; the proxy resolves and pins", async () => {
    const { fetcher, eg } = await fetcherFor({ "pinned.test": ["127.0.0.1"] });
    const { res, url } = await fetcher.open(`http://pinned.test:${srv.port}/ok`);
    assert.equal(res.statusCode, 200);
    assert.equal(await drain(res), "hello");
    assert.equal(url, `http://pinned.test:${srv.port}/ok`);
    assert.deepEqual(eg.calls, ["pinned.test"], "only the proxy resolved the name");
    assert.deepEqual(eg.allowed, [{ kind: "GET", target: `pinned.test:${srv.port}` }]);
    assert.equal(hits.at(-1).host, `pinned.test:${srv.port}`);
    assert.equal(hits.at(-1).url, "/ok", "the origin gets origin-form, not the proxy's absolute URI");
  });

  it("tunnels https with CONNECT, sends SNI and verifies the certificate against the real host", async () => {
    const { fetcher, eg } = await fetcherFor({ "secure.test": ["127.0.0.1"] });
    const { res } = await fetcher.open(`https://secure.test:${tlsSrv.port}/hi`);
    assert.equal(await drain(res), "secure");
    assert.equal(tlsHits.at(-1).sni, "secure.test");
    assert.equal(tlsHits.at(-1).host, `secure.test:${tlsSrv.port}`);
    assert.deepEqual(eg.allowed, [{ kind: "CONNECT", target: `secure.test:${tlsSrv.port}` }]);
    // cdn.discordapp.com is the certificate's other SAN.
    const { fetcher: f2 } = await fetcherFor({ "cdn.discordapp.com": ["127.0.0.1"] });
    const r2 = await f2.open(`https://cdn.discordapp.com:${tlsSrv.port}/x`);
    assert.equal(await drain(r2.res), "secure");
    assert.equal(tlsHits.at(-1).sni, "cdn.discordapp.com");
  });

  it("refuses a certificate that does not name the host", async () => {
    const { fetcher } = await fetcherFor({ "other.test": ["127.0.0.1"] });
    await assert.rejects(fetcher.open(`https://other.test:${tlsSrv.port}/hi`), (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID");
  });

  it("refuses a certificate from an untrusted issuer", async () => {
    const { fetcher } = await fetcherFor({ "secure.test": ["127.0.0.1"] }, { ca: null });
    await assert.rejects(fetcher.open(`https://secure.test:${tlsSrv.port}/hi`), (e) =>
      /SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code),
    );
  });

  it("sends no SNI for an IP literal and still checks the certificate", async () => {
    // A bare TLS server of its own, so only this test's handshake is seen.
    const handshakes = [];
    const raw = tls.createServer({ key: fixture("test-tls.key"), cert: CA }, (s) => {
      handshakes.push(s.servername);
      s.end();
    });
    raw.on("tlsClientError", (_e, s) => handshakes.push(s.servername));
    await new Promise((r) => raw.listen(0, "127.0.0.1", r));
    const rawPort = raw.address().port;
    try {
      const eg = await startProxy({ "other.test": ["127.0.0.1"] }, { allowedPorts: [rawPort] });
      proxies.push(eg);
      const fetcher = createSafeFetcher({ proxy: { host: "127.0.0.1", port: eg.port }, allowedPorts: [rawPort], tls: { ca: CA } });
      await assert.rejects(fetcher.open(`https://127.0.0.1:${rawPort}/hi`), (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID");
      await waitFor(() => handshakes.length === 1, { timeoutMs: 3000 });
      assert.ok(!handshakes[0], `no server_name extension for an IP literal (got ${handshakes[0]})`);
      // Same failure for a name the cert doesn't cover — but that one did send SNI.
      await assert.rejects(fetcher.open(`https://other.test:${rawPort}/hi`), (e) => e.code === "ERR_TLS_CERT_ALTNAME_INVALID");
      await waitFor(() => handshakes.length === 2, { timeoutMs: 3000 });
      assert.equal(handshakes[1], "other.test");
    } finally {
      await new Promise((r) => raw.close(r));
    }
  });

  it("turns the proxy's refusal of a CONNECT into EgressBlockedError", async () => {
    const { fetcher, eg } = await fetcherFor({ "lan.test": ["192.168.2.1"] });
    await assert.rejects(
      fetcher.open(`https://lan.test:${tlsSrv.port}/x`),
      (e) => e instanceof EgressBlockedError && e.reason === "private" && /lan\.test/.test(e.message),
    );
    assert.equal(eg.blocked.at(-1).kind, "CONNECT");
  });

  it("refuses a redirect into a private range before connecting", async () => {
    const { fetcher, calls } = await fetcherFor({ "a.test": ["127.0.0.1"], "lan.test": ["192.168.2.1"] });
    const loc = encodeURIComponent(`http://lan.test:${srv.port}/ok`);
    await assert.rejects(
      fetcher.open(`http://a.test:${srv.port}/to?loc=${loc}`),
      (e) => e instanceof EgressBlockedError && e.reason === "private",
    );
    assert.deepEqual(calls, ["a.test", "lan.test"]);
  });

  it("refuses a redirect to a private IP literal", async () => {
    const { fetcher } = await fetcherFor({ "a.test": ["127.0.0.1"] });
    const loc = encodeURIComponent(`http://10.0.0.7:${srv.port}/ok`);
    await assert.rejects(fetcher.open(`http://a.test:${srv.port}/to?loc=${loc}`), (e) => e instanceof EgressBlockedError && e.reason === "private");
  });

  it("re-resolves and re-vets every hop (DNS rebinding between hops)", async () => {
    // First answer is fine, the second (same host, next hop) points at the LAN.
    const { fetcher, calls } = await fetcherFor({
      "rebind.test": (n) => (n === 0 ? ["127.0.0.1"] : ["10.0.0.5"]),
    });
    const loc = encodeURIComponent("/ok");
    await assert.rejects(
      fetcher.open(`http://rebind.test:${srv.port}/to?loc=${loc}`),
      (e) => e instanceof EgressBlockedError && e.reason === "private",
    );
    assert.deepEqual(calls, ["rebind.test", "rebind.test"]);
  });

  it("blocks a host whose answer mixes public and private addresses", async () => {
    const { fetcher } = await fetcherFor({ "mixed.test": ["127.0.0.1", "172.16.0.9"] });
    await assert.rejects(fetcher.open(`http://mixed.test:${srv.port}/ok`), EgressBlockedError);
  });

  it("follows https redirects but refuses an https → http downgrade", async () => {
    const { fetcher } = await fetcherFor({ "secure.test": ["127.0.0.1"], "plain.test": ["127.0.0.1"] });
    await assert.rejects(
      fetcher.open(`https://secure.test:${tlsSrv.port}/down`),
      (e) => e instanceof EgressBlockedError && e.reason === "downgrade",
    );
  });

  it("rejects bad schemes, userinfo, ports and non-allowlisted hosts without asking the proxy", async () => {
    const { fetcher, eg } = await fetcherFor({ "a.test": ["127.0.0.1"] });
    await assert.rejects(fetcher.open("ftp://a.test/x"), (e) => e.reason === "scheme");
    await assert.rejects(fetcher.open("file:///etc/passwd"), (e) => e.reason === "scheme");
    await assert.rejects(fetcher.open(`http://user:pw@a.test:${srv.port}/ok`), (e) => e.reason === "userinfo");
    await assert.rejects(fetcher.open("http://a.test:22/ok"), (e) => e.reason === "port");
    await assert.rejects(
      fetcher.open(`http://a.test:${srv.port}/ok`, { allowHost: () => false }),
      (e) => e.reason === "host",
    );
    await assert.rejects(fetcher.open("not a url"), (e) => e.reason === "invalid");
    assert.deepEqual(eg.calls, []);
  });

  it("applies the host allowlist to every redirect hop", async () => {
    const { fetcher } = await fetcherFor({ "cdn.discordapp.com": ["127.0.0.1"], "evil.test": ["127.0.0.1"] });
    const loc = encodeURIComponent(`http://evil.test:${srv.port}/ok`);
    await assert.rejects(
      fetcher.open(`http://cdn.discordapp.com:${srv.port}/to?loc=${loc}`, { allowHost: isProxyAllowedHost }),
      (e) => e.reason === "host",
    );
  });

  it("drops credentials when a redirect changes host, keeps them on the same host", async () => {
    const { fetcher } = await fetcherFor({ "a.test": ["127.0.0.1"], "b.test": ["127.0.0.1"] });
    const cross = encodeURIComponent(`http://b.test:${srv.port}/ok`);
    const r1 = await fetcher.open(`http://a.test:${srv.port}/to?loc=${cross}`, { headers: { Cookie: "s=1" } });
    await drain(r1.res);
    assert.equal(hits.at(-1).host, `b.test:${srv.port}`);
    assert.equal(hits.at(-1).cookie, undefined);

    const same = encodeURIComponent("/ok");
    const r2 = await fetcher.open(`http://a.test:${srv.port}/to?loc=${same}`, { headers: { Cookie: "s=1" } });
    await drain(r2.res);
    assert.equal(hits.at(-1).cookie, "s=1");
  });

  it("turns POST into GET on 303 and keeps it (with its body) on 307", async () => {
    const { fetcher } = await fetcherFor({ "a.test": ["127.0.0.1"] });
    const loc = encodeURIComponent("/echo-method");
    const r303 = await fetcher.open(`http://a.test:${srv.port}/to?code=303&loc=${loc}`, { method: "POST", body: "x=1" });
    assert.equal(await drain(r303.res), "GET:");
    const r307 = await fetcher.open(`http://a.test:${srv.port}/to?code=307&loc=${loc}`, { method: "POST", body: "x=1" });
    assert.equal(await drain(r307.res), "POST:x=1");
  });

  it("stops after 5 redirects", async () => {
    const { fetcher } = await fetcherFor({ "a.test": ["127.0.0.1"] });
    await assert.rejects(fetcher.open(`http://a.test:${srv.port}/loop`), /Too many redirects/);
  });

  it("passes non-2xx statuses through untouched", async () => {
    const { fetcher } = await fetcherFor({ "a.test": ["127.0.0.1"] });
    const { res } = await fetcher.open(`http://a.test:${srv.port}/missing`);
    assert.equal(res.statusCode, 404);
    assert.equal(await drain(res), "nope");
  });

  it("an upstream can't fake the proxy's refusal markers", async () => {
    const { fetcher } = await fetcherFor({ "a.test": ["127.0.0.1"] });
    const { res } = await fetcher.open(`http://a.test:${srv.port}/fake-marker`);
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers["x-convertx-egress"], undefined);
    assert.equal(await drain(res), "site says no");
  });

  it("reports names the proxy can't resolve as ENOTFOUND", async () => {
    const { fetcher } = await fetcherFor({});
    await assert.rejects(fetcher.open(`http://nowhere.test:${srv.port}/ok`), (e) => e.code === "ENOTFOUND");
    await assert.rejects(fetcher.open(`https://nowhere.test:${tlsSrv.port}/ok`), (e) => e.code === "ENOTFOUND");
  });

  it("presents EGRESS_TOKEN to the proxy (http and https)", async () => {
    const token = "egress-token-0123456789abcdef";
    const { fetcher, eg } = await fetcherFor({ "a.test": ["127.0.0.1"], "secure.test": ["127.0.0.1"] }, { proxyToken: token });
    assert.equal(await drain((await fetcher.open(`http://a.test:${srv.port}/ok`)).res), "hello");
    assert.equal(await drain((await fetcher.open(`https://secure.test:${tlsSrv.port}/ok`)).res), "secure");
    assert.equal(eg.allowed.length, 2);
    assert.equal(eg.authFailures.length, 0);
  });

  it("a wrong or missing token is refused by the proxy (EGRESS_AUTH)", async () => {
    const token = "egress-token-0123456789abcdef";
    for (const fetcherToken of ["wrong-token-0123456789abcdef", ""]) {
      const { fetcher, eg } = await fetcherFor(
        { "a.test": ["127.0.0.1"], "secure.test": ["127.0.0.1"] },
        { proxyToken: token, fetcherToken },
      );
      await assert.rejects(fetcher.open(`http://a.test:${srv.port}/ok`), (e) => e instanceof UpstreamError && e.code === "EGRESS_AUTH");
      await assert.rejects(fetcher.open(`https://secure.test:${tlsSrv.port}/ok`), (e) => e.code === "EGRESS_AUTH");
      assert.deepEqual(eg.calls, [], "nothing was resolved for an unauthenticated client");
      assert.equal(eg.authFailures.length, fetcherToken ? 2 : 0, "only a presented-but-wrong token is logged");
    }
  });

  it("says so when the egress proxy itself is down", async () => {
    const fetcher = createSafeFetcher({ proxy: { host: "127.0.0.1", port: await deadPort() }, allowedPorts: [srv.port, tlsSrv.port] });
    await assert.rejects(fetcher.open(`http://a.test:${srv.port}/ok`), (e) => e.code === "EGRESS_DOWN");
    await assert.rejects(fetcher.open(`https://a.test:${tlsSrv.port}/ok`), (e) => e.code === "EGRESS_DOWN");
  });

  it("can't be built without a proxy (there is no direct mode)", () => {
    assert.throws(() => createSafeFetcher({}), /egress proxy/);
    assert.throws(() => createSafeFetcher(), /egress proxy/);
  });

  it("an abort mid-tunnel rejects with the abort reason", async () => {
    const { fetcher } = await fetcherFor({ "secure.test": ["127.0.0.1"] });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(fetcher.open(`https://secure.test:${tlsSrv.port}/hi`, { signal: ac.signal }), (e) => e.name === "AbortError");
  });
});

describe("helpers", () => {
  it("isProxyAllowedHost covers the prober hosts and nothing else", () => {
    for (const h of [
      "cdn.syndication.twimg.com",
      "pbs.twimg.com",
      "video.twimg.com",
      "www.instagram.com",
      "instagram.com",
      "scontent-fra5-1.cdninstagram.com",
      "scontent.xx.fbcdn.net",
      "cdn.discordapp.com",
      "media.discordapp.net",
      "images-ext-1.discordapp.net",
      "tenor.com",
      "media.tenor.com",
      "media1.tenor.com",
      "i.giphy.com",
      "media2.giphy.com",
      "static.klipy.com",
      "static2.klipy.com",
      "CDN.DISCORDAPP.COM",
    ]) {
      assert.equal(isProxyAllowedHost(h), true, h);
    }
    for (const h of [
      "evil.com",
      "twimg.com.evil.com",
      "notinstagram.com",
      "discordapp.com",
      "discord.com",
      "api.klipy.com",
      "klipy.com",
      "127.0.0.1",
      "::1",
      "",
      "eviltenor.com",
    ]) {
      assert.equal(isProxyAllowedHost(h), false, h);
    }
  });

  it("joinRawHeaders lowercases and joins repeats like the Rust payload", () => {
    assert.deepEqual(joinRawHeaders(["Set-Cookie", "a=1", "Content-Type", "text/html", "set-cookie", "b=2"]), {
      "set-cookie": "a=1, b=2",
      "content-type": "text/html",
    });
  });

  it("decodeText honours the charset and is lossy, never throwing", () => {
    assert.equal(decodeText(Buffer.from([0xe4]), "text/html; charset=ISO-8859-1"), "ä");
    assert.equal(decodeText(Buffer.from("héllo"), "application/json"), "héllo");
    assert.equal(decodeText(Buffer.from([0xff, 0x41]), "text/plain"), "�A");
    assert.equal(decodeText(Buffer.from("x"), "text/plain; charset=bogus-charset"), "x");
  });
});
