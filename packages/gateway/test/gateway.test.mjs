// Drives the Worker's exported fetch handler in Node 22 with a fake env.NAS
// (the Workers VPC binding) and a stubbed global fetch (the internet).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import worker, {
  allowedOrigin,
  capStream,
  matchAccessKey,
  normaliseKlipy,
  parseAccessKeys,
  timingSafeEqualStr,
} from "../src/index.js";

const BASE = "https://convertx-api.rr-admin-panel.workers.dev";
const SITE = "https://convert-x-online.pages.dev";
const ALICE = "alice-key-0123456789abcdef";
const BOB = "bob-key-0123456789abcdefgh";
const ORIGIN_KEY = "origin-secret-0123456789abcdef";
const TOKEN = "a".repeat(64);

let fetchCalls;
let fetchImpl;
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  fetchImpl = async () => new Response("unexpected upstream call", { status: 599 });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    fetchCalls.push({ url, init });
    return fetchImpl(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeNas(handler = async () => Response.json({ ok: true })) {
  const calls = [];
  return {
    calls,
    async fetch(url, init = {}) {
      const headers = new Headers(init.headers || {});
      const body = init.body ? new TextDecoder().decode(init.body) : null;
      calls.push({ url, method: init.method || "GET", headers, body });
      return handler(url, init);
    },
  };
}

function makeEnv(over = {}) {
  return {
    ALLOWED_ORIGINS: `${SITE},http://localhost:3000,http://localhost:4173`,
    ACCESS_KEYS: `alice:${ALICE},bob:${BOB}`,
    ORIGIN_KEY,
    KLIPY_API_KEY: "klipy-test-key",
    NAS: fakeNas(),
    ...over,
  };
}

function req(path, { method = "GET", headers = {}, body } = {}) {
  return new Request(BASE + path, { method, headers, body });
}

const call = (path, opts, env = makeEnv()) => worker.fetch(req(path, opts), env);

describe("health + routing", () => {
  it("GET /v1/health reports what is configured", async () => {
    const res = await call("/v1/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: "convertx-gateway", downloader: true, klipy: true });
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");

    const bare = await worker.fetch(req("/v1/health"), { ALLOWED_ORIGINS: SITE });
    assert.deepEqual(await bare.json(), { ok: true, service: "convertx-gateway", downloader: false, klipy: false });
  });

  it("unknown paths are JSON 404s that still carry CORP", async () => {
    for (const p of ["/", "/v1", "/v1/nope", "/v1/dl", "/v2/health"]) {
      const res = await call(p);
      assert.equal(res.status, 404, p);
      assert.deepEqual(await res.json(), { error: "Not found" });
      assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
    }
  });
});

describe("CORS", () => {
  const auth = { Authorization: `Bearer ${ALICE}` };

  it("keyed routes reflect only allowed origins, with Vary: Origin", async () => {
    const cases = [
      [SITE, SITE],
      ["https://feat-sticker.convert-x-online.pages.dev", "https://feat-sticker.convert-x-online.pages.dev"],
      ["http://localhost:3000", "http://localhost:3000"],
      ["http://localhost:4173", "http://localhost:4173"],
      ["http://localhost:5173", null],
      ["https://evil.example", null],
      ["https://a.b.convert-x-online.pages.dev", null],
      ["http://feat.convert-x-online.pages.dev", null],
      ["https://convert-x-online.pages.dev.evil.example", null],
      ["https://FEAT.convert-x-online.pages.dev", null],
      [null, null],
    ];
    for (const [origin, want] of cases) {
      const headers = { ...auth, ...(origin ? { Origin: origin } : {}) };
      const res = await call("/v1/dl/jobs/x", { headers });
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), want, String(origin));
      assert.equal(res.headers.get("Vary"), "Origin");
      assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
    }
  });

  it("the file route uses the same reflection rules", async () => {
    const env = makeEnv({ NAS: fakeNas(async () => new Response("bytes")) });
    const ok = await call(`/v1/file/abc?t=${TOKEN}`, { headers: { Origin: SITE } }, env);
    assert.equal(ok.headers.get("Access-Control-Allow-Origin"), SITE);
    const bad = await call(`/v1/file/abc?t=${TOKEN}`, { headers: { Origin: "https://evil.example" } }, env);
    assert.equal(bad.headers.get("Access-Control-Allow-Origin"), null);
  });

  it("public routes answer any origin with *", async () => {
    const res = await call("/v1/health", { headers: { Origin: "https://evil.example" } });
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.headers.get("Vary"), null);
  });

  it("preflight: 204 with the allowed headers/methods/max-age", async () => {
    const res = await call("/v1/dl/jobs", {
      method: "OPTIONS",
      headers: { Origin: SITE, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), SITE);
    assert.equal(res.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type, Range");
    assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, HEAD, POST, DELETE, OPTIONS");
    assert.equal(res.headers.get("Access-Control-Max-Age"), "86400");
    assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
    assert.equal(await res.text(), "");

    const evil = await call("/v1/dl/jobs", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(evil.status, 204);
    assert.equal(evil.headers.get("Access-Control-Allow-Origin"), null);

    const pub = await call("/v1/media", { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(pub.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(fetchCalls.length, 0);
  });

  it("allowedOrigin trims the configured list", () => {
    assert.equal(allowedOrigin("https://x.test", { ALLOWED_ORIGINS: " https://y.test , https://x.test " }), "https://x.test");
    assert.equal(allowedOrigin("https://x.test", {}), null);
  });
});

describe("access keys", () => {
  it("rejects missing, wrong, near-miss and non-Bearer keys without touching the NAS", async () => {
    const env = makeEnv();
    for (const headers of [
      {},
      { Authorization: "Bearer " },
      { Authorization: "Bearer nope" },
      { Authorization: `Bearer ${ALICE.slice(0, -1)}X` },
      { Authorization: `Bearer ${ALICE}x` },
      { Authorization: `Bearer ${ALICE.slice(0, -1)}` },
      { Authorization: `Basic ${ALICE}` },
      { Authorization: ALICE },
      { Authorization: `Bearer ${ALICE} extra` },
      { Authorization: `Bearer ${ORIGIN_KEY}` },
    ]) {
      const res = await worker.fetch(req("/v1/dl/health", { headers }), env);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.deepEqual(await res.json(), { error: "Invalid access key" });
      assert.equal(res.headers.get("WWW-Authenticate"), 'Bearer realm="convertx"');
    }
    assert.equal(env.NAS.calls.length, 0);
  });

  it("accepts each configured key and forwards its name", async () => {
    const env = makeEnv();
    await worker.fetch(req("/v1/dl/health", { headers: { Authorization: `Bearer ${ALICE}` } }), env);
    await worker.fetch(req("/v1/dl/health", { headers: { Authorization: `bearer ${BOB}` } }), env);
    assert.deepEqual(
      env.NAS.calls.map((c) => c.headers.get("X-ConvertX-Key-Id")),
      ["alice", "bob"],
    );
  });

  it("parseAccessKeys ignores malformed and weak entries", () => {
    const keys = parseAccessKeys(
      "good:0123456789abcdef0, short:abc ,:0123456789abcdef0,bad name:0123456789abcdef0,\nnewline:fedcba9876543210ff,colon:key:with:colons:0123",
    );
    assert.deepEqual(keys, [
      { name: "good", key: "0123456789abcdef0" },
      { name: "newline", key: "fedcba9876543210ff" },
      { name: "colon", key: "key:with:colons:0123" },
    ]);
    assert.deepEqual(parseAccessKeys(undefined), []);
  });

  it("timingSafeEqualStr hashes both sides and compares every byte", async () => {
    assert.equal(await timingSafeEqualStr("abc", "abc"), true);
    assert.equal(await timingSafeEqualStr("abc", "abd"), false);
    assert.equal(await timingSafeEqualStr("abc", "abcd"), false);
    assert.equal(await timingSafeEqualStr("", ""), true);
  });

  it("uses crypto.subtle.timingSafeEqual when the runtime has it (Workers)", async () => {
    const subtle = crypto.subtle;
    const seen = [];
    subtle.timingSafeEqual = (a, b) => {
      seen.push([a.byteLength, b.byteLength]);
      return a.every((x, i) => x === b[i]);
    };
    try {
      assert.equal(await timingSafeEqualStr("same", "same"), true);
      assert.equal(await timingSafeEqualStr("same", "different-length"), false);
      assert.deepEqual(seen, [[32, 32], [32, 32]]);
    } finally {
      delete subtle.timingSafeEqual;
    }
  });

  it("checks every configured key — no early exit on a match", async () => {
    const subtle = crypto.subtle;
    const orig = subtle.digest;
    let digests = 0;
    subtle.digest = function (...a) {
      digests++;
      return orig.apply(this, a);
    };
    try {
      const env = { ACCESS_KEYS: `a:${"1".repeat(20)},b:${"2".repeat(20)},c:${"3".repeat(20)}` };
      assert.equal(await matchAccessKey(env, "1".repeat(20)), "a");
      assert.equal(digests, 6); // 3 keys × (key + presented)
      digests = 0;
      assert.equal(await matchAccessKey(env, "nope"), null);
      assert.equal(digests, 6);
    } finally {
      delete subtle.digest;
      assert.equal(subtle.digest, orig);
    }
  });
});

describe("/v1/dl forwarding", () => {
  const auth = { Authorization: `Bearer ${ALICE}`, "CF-Connecting-IP": "203.0.113.7" };

  it("forwards method, body, content-type and the identity headers", async () => {
    const env = makeEnv({
      NAS: fakeNas(async () => Response.json({ jobId: "j1", token: TOKEN }, { status: 202 })),
    });
    const res = await worker.fetch(
      req("/v1/dl/jobs", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json", Origin: SITE, Cookie: "nope=1" },
        body: JSON.stringify({ url: "https://www.youtube.com/watch?v=x", format: "mp4" }),
      }),
      env,
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { jobId: "j1", token: TOKEN });
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const c = env.NAS.calls[0];
    assert.equal(c.url, "http://convertx-api:8080/jobs");
    assert.equal(c.method, "POST");
    assert.equal(c.body, '{"url":"https://www.youtube.com/watch?v=x","format":"mp4"}');
    assert.equal(c.headers.get("Content-Type"), "application/json");
    assert.equal(c.headers.get("X-ConvertX-Origin-Key"), ORIGIN_KEY);
    assert.equal(c.headers.get("X-ConvertX-Key-Id"), "alice");
    assert.equal(c.headers.get("X-ConvertX-Client-IP"), "203.0.113.7");
    assert.equal(c.headers.get("Authorization"), null, "the user's key never reaches the NAS");
    assert.equal(c.headers.get("Cookie"), null);
  });

  it("keeps the query string and passes statuses + headers through", async () => {
    const env = makeEnv({
      NAS: fakeNas(async (url) =>
        url.includes("/direct")
          ? new Response("not found", { status: 404, headers: { "X-Upstream-Status": "404" } })
          : Response.json({ error: "Hourly download limit reached" }, { status: 429, headers: { "Retry-After": "120" } }),
      ),
    });
    const target = encodeURIComponent("https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&hm=2");
    const r1 = await worker.fetch(req(`/v1/dl/direct?url=${target}&name=a.png`, { headers: { ...auth, Origin: SITE } }), env);
    assert.equal(env.NAS.calls[0].url, `http://convertx-api:8080/direct?url=${target}&name=a.png`);
    assert.equal(r1.status, 404);
    assert.equal(r1.headers.get("X-Upstream-Status"), "404");
    assert.match(r1.headers.get("Access-Control-Expose-Headers"), /X-Upstream-Status/);

    const r2 = await worker.fetch(req("/v1/dl/jobs", { method: "POST", headers: auth, body: "{}" }), env);
    assert.equal(r2.status, 429);
    assert.equal(r2.headers.get("Retry-After"), "120");

    await worker.fetch(req("/v1/dl/jobs/j1", { method: "DELETE", headers: auth }), env);
    assert.equal(env.NAS.calls.at(-1).method, "DELETE");
    assert.equal(env.NAS.calls.at(-1).url, "http://convertx-api:8080/jobs/j1");
  });

  it("503 'Downloader offline' when the binding is missing or the tunnel is down", async () => {
    const noBinding = await worker.fetch(req("/v1/dl/health", { headers: auth }), makeEnv({ NAS: undefined }));
    assert.equal(noBinding.status, 503);
    assert.deepEqual(await noBinding.json(), { error: "Downloader offline" });

    const down = makeEnv({
      NAS: {
        async fetch() {
          throw new Error("Network connection lost.");
        },
      },
    });
    const r = await worker.fetch(req("/v1/dl/jobs/x", { headers: { ...auth, Origin: SITE } }), down);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: "Downloader offline" });
    assert.equal(r.headers.get("Access-Control-Allow-Origin"), SITE);

    const noOriginKey = await worker.fetch(req("/v1/dl/health", { headers: auth }), makeEnv({ ORIGIN_KEY: "" }));
    assert.equal(noOriginKey.status, 503);
  });

  it("refuses odd methods, big bodies and odd paths", async () => {
    const env = makeEnv();
    assert.equal((await worker.fetch(req("/v1/dl/jobs", { method: "PUT", headers: auth, body: "{}" }), env)).status, 405);
    const big = "x".repeat(1024 * 1024 + 1);
    assert.equal((await worker.fetch(req("/v1/dl/jobs", { method: "POST", headers: auth, body: big }), env)).status, 413);
    assert.equal((await worker.fetch(req("/v1/dl/jobs%2Fx", { headers: auth }), env)).status, 404);
    assert.equal(env.NAS.calls.length, 0);
  });
});

describe("/v1/file passthrough", () => {
  it("streams the NAS answer without the origin key", async () => {
    const env = makeEnv({
      NAS: fakeNas(
        async () =>
          new Response("FILEBYTES", {
            status: 206,
            headers: {
              "Content-Type": "video/mp4",
              "Content-Disposition": `attachment; filename="a.mp4"; filename*=UTF-8''a.mp4`,
              "Content-Range": "bytes 0-8/100",
            },
          }),
      ),
    });
    const res = await worker.fetch(
      req(`/v1/file/AbC_d-9?t=${TOKEN}`, { headers: { Range: "bytes=0-8", Origin: SITE, "CF-Connecting-IP": "198.51.100.1" } }),
      env,
    );
    assert.equal(res.status, 206);
    assert.equal(await res.text(), "FILEBYTES");
    assert.equal(res.headers.get("Content-Disposition"), `attachment; filename="a.mp4"; filename*=UTF-8''a.mp4`);
    assert.match(res.headers.get("Access-Control-Expose-Headers"), /Content-Disposition/);
    const c = env.NAS.calls[0];
    assert.equal(c.url, `http://convertx-api:8080/jobs/AbC_d-9/file?t=${TOKEN}`);
    assert.equal(c.headers.get("Range"), "bytes=0-8");
    assert.equal(c.headers.get("X-ConvertX-Origin-Key"), null);
    assert.equal(c.headers.get("X-ConvertX-Client-IP"), "198.51.100.1");
  });

  it("404s malformed ids/tokens locally and 503s without a NAS", async () => {
    const env = makeEnv();
    for (const p of ["/v1/file/abc", "/v1/file/abc?t=xyz", `/v1/file/a.b?t=${TOKEN}`, `/v1/file/${"a".repeat(65)}?t=${TOKEN}`]) {
      assert.equal((await worker.fetch(req(p), env)).status, 404, p);
    }
    assert.equal(env.NAS.calls.length, 0);
    assert.equal((await worker.fetch(req(`/v1/file/abc?t=${TOKEN}`), makeEnv({ NAS: null }))).status, 503);
    assert.equal((await worker.fetch(req(`/v1/file/abc?t=${TOKEN}`, { method: "POST", body: "x" }), env)).status, 405);
  });
});

describe("/v1/media", () => {
  const media = (u, opts) => call(`/v1/media?url=${encodeURIComponent(u)}`, opts);

  it("rejects anything off the allowlist before any upstream fetch", async () => {
    for (const u of [
      "",
      "not a url",
      "https://127.0.0.1/x.png",
      "https://192.168.2.201/x.gif",
      "https://[::1]/x.png",
      "https://evil.example/x.gif",
      "https://cdn.discordapp.com.evil.example/x.png",
      "https://discord.com/stickers/1.json",
      "https://user@cdn.discordapp.com/emojis/1.png",
      "https://cdn.discordapp.com@evil.example/x.png",
      "https://cdn.discordapp.com\\@evil.example/x.png",
      "https://cdn.discordapp.com:8443/emojis/1.png",
      "http://cdn.discordapp.com/emojis/1.png",
      "https://tenor.com/search/cats",
      "https://api.klipy.com/api/v1/key/gifs/items",
      "file:///etc/passwd",
      `https://media.discordapp.net/${"a".repeat(4100)}`,
    ]) {
      const res = await media(u);
      assert.ok([400, 403].includes(res.status), `${u} → ${res.status}`);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    }
    assert.equal(fetchCalls.length, 0);
  });

  it("proxies an allowed URL with status passthrough, CORS/CORP and X-Final-Url", async () => {
    fetchImpl = async () =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Length": "4", "Set-Cookie": "x=1", "X-Goog-Hash": "secret" },
      });
    const res = await media("https://media.discordapp.net/stickers/781291131828699156.png", { headers: { Range: "bytes=0-3" } });
    assert.equal(res.status, 200);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(res.headers.get("Content-Type"), "image/png");
    assert.equal(res.headers.get("Content-Length"), "4");
    assert.equal(res.headers.get("X-Final-Url"), "https://media.discordapp.net/stickers/781291131828699156.png");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.headers.get("Access-Control-Expose-Headers"), "Content-Type, Content-Length, Content-Range, X-Final-Url");
    assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=86400");
    assert.equal(res.headers.get("Set-Cookie"), null);
    assert.equal(res.headers.get("X-Goog-Hash"), null);

    const { init } = fetchCalls[0];
    assert.equal(init.redirect, "manual");
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Range, "bytes=0-3");
    assert.match(init.headers["User-Agent"], /ConvertX-Gateway/);
    assert.deepEqual(init.cf, { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "300-599": 0 } });

    fetchImpl = async () => new Response("This content is no longer available.", { status: 404, headers: { "Content-Type": "text/plain" } });
    const gone = await media("https://cdn.discordapp.com/attachments/1/2/a.png?ex=1");
    assert.equal(gone.status, 404);
    assert.equal(gone.headers.get("Cache-Control"), "no-store");
    assert.equal(await gone.text(), "This content is no longer available.");
  });

  it("HEAD goes upstream as HEAD and returns no body", async () => {
    fetchImpl = async (_u, init) => new Response(null, { status: 200, headers: { "Content-Type": "application/json", "X-Method": init.method } });
    const res = await media("https://cdn.discordapp.com/stickers/796140620111544330.json", { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(fetchCalls[0].init.method, "HEAD");
    assert.equal(res.headers.get("Content-Type"), "application/json");
    assert.equal(await res.text(), "");
  });

  it("follows redirects only while they stay on the allowlist", async () => {
    fetchImpl = async (u) => {
      if (u === "https://tenor.com/bP0Zs.gif") return new Response(null, { status: 301, headers: { Location: "/view/rick-roll-gif-24750852" } });
      if (u === "https://tenor.com/view/rick-roll-gif-24750852") return new Response("<html>og</html>", { status: 200, headers: { "Content-Type": "text/html" } });
      if (u === "https://tenor.com/evil.gif") return new Response(null, { status: 302, headers: { Location: "https://evil.example/x" } });
      if (u === "https://tenor.com/down.gif") return new Response(null, { status: 302, headers: { Location: "http://media.tenor.com/x" } });
      if (u === "https://tenor.com/lan.gif") return new Response(null, { status: 302, headers: { Location: "https://192.168.2.201/x" } });
      if (u === "https://tenor.com/loop.gif") return new Response(null, { status: 302, headers: { Location: "/loop.gif" } });
      return new Response("?", { status: 500 });
    };
    const ok = await media("https://tenor.com/bP0Zs.gif");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("X-Final-Url"), "https://tenor.com/view/rick-roll-gif-24750852");
    assert.equal(await ok.text(), "<html>og</html>");
    for (const u of ["https://tenor.com/evil.gif", "https://tenor.com/down.gif", "https://tenor.com/lan.gif"]) {
      const before = fetchCalls.length;
      const r = await media(u);
      assert.equal(r.status, 403, u);
      assert.equal(fetchCalls.length, before + 1, "the disallowed hop is never fetched");
    }
    const loop = await media("https://tenor.com/loop.gif");
    assert.equal(loop.status, 502);
  });

  it("caps size: refuses a declared size over 50 MB and cuts an undeclared stream past it", async () => {
    fetchImpl = async () => new Response("x", { headers: { "Content-Length": String(60 * 1024 * 1024) } });
    const declared = await media("https://media.tenor.com/abcdefghijkAAAAC/tenor.gif");
    assert.equal(declared.status, 413);

    const chunk = new Uint8Array(1024 * 1024);
    fetchImpl = async () => {
      let n = 0;
      const body = new ReadableStream({
        pull(ctl) {
          if (n++ < 51) ctl.enqueue(chunk);
          else ctl.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "image/gif" } });
    };
    const streamed = await media("https://media.tenor.com/abcdefghijkAAAAC/tenor.gif");
    assert.equal(streamed.status, 200);
    await assert.rejects(streamed.arrayBuffer());
  });

  it("502 when the media host is unreachable", async () => {
    fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };
    const res = await media("https://i.giphy.com/Ju7l5y9osyymQ.gif");
    assert.equal(res.status, 502);
  });

  it("capStream passes small bodies and errors past the cap", async () => {
    const small = new Response(capStream(new Response("hello").body, 10));
    assert.equal(await small.text(), "hello");
    const big = new Response(capStream(new Response("hello world!").body, 10));
    await assert.rejects(big.text(), /exceeds 10 bytes/);
  });
});

describe("/v1/resolve/klipy", () => {
  const ITEM = {
    uuid: "098ae17d",
    slug: "archer-jazz-hands",
    title: "Archer Jazz Hands",
    file: {
      hd: {
        gif: { url: "https://static2.klipy.com/ii/39/1f/e5/gkd36vgF.gif", width: 498, height: 278, size: 1213193 },
        mp4: { url: "https://static2.klipy.com/ii/39/1f/e5/1yUJ.mp4", width: 498, height: 278, size: 87564 },
        jpg: { url: "http://static2.klipy.com/insecure.jpg", width: 498, height: 278 },
        avif: { url: "https://static2.klipy.com/x.avif" },
      },
      sm: { webp: { url: "https://static2.klipy.com/ii/39/1f/e5/s.webp", width: 220, height: 123, size: "12" } },
      weird: { gif: { url: "https://x/y.gif" } },
    },
  };
  const NORMALISED = {
    title: "Archer Jazz Hands",
    files: {
      hd: {
        gif: { url: "https://static2.klipy.com/ii/39/1f/e5/gkd36vgF.gif", width: 498, height: 278, size: 1213193 },
        mp4: { url: "https://static2.klipy.com/ii/39/1f/e5/1yUJ.mp4", width: 498, height: 278, size: 87564 },
      },
      sm: { webp: { url: "https://static2.klipy.com/ii/39/1f/e5/s.webp", width: 220, height: 123, size: null } },
    },
  };

  it("501 without a Klipy key, 400 on bad input", async () => {
    const no = await call("/v1/resolve/klipy?type=gifs&slug=x", {}, makeEnv({ KLIPY_API_KEY: undefined }));
    assert.equal(no.status, 501);
    assert.match((await no.json()).error, /Klipy/);
    assert.equal((await call("/v1/resolve/klipy?type=videos&slug=x")).status, 400);
    assert.equal((await call("/v1/resolve/klipy?type=gifs&slug=../x")).status, 400);
    assert.equal((await call("/v1/resolve/klipy?type=gifs")).status, 400);
    assert.equal(fetchCalls.length, 0);
  });

  it("resolves through the Klipy API and normalises to {title, files}", async () => {
    fetchImpl = async () => Response.json({ result: true, data: { data: [{ ...ITEM, slug: "other" }, ITEM] } });
    const res = await call("/v1/resolve/klipy?type=gifs&slug=archer-jazz-hands");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), NORMALISED);
    assert.equal(fetchCalls[0].url, "https://api.klipy.com/api/v1/klipy-test-key/gifs/items?slugs=archer-jazz-hands");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(res.headers.get("Cache-Control"), "public, max-age=3600");
  });

  it("maps upstream failures", async () => {
    fetchImpl = async () => Response.json({ result: true, data: { data: [] } });
    assert.equal((await call("/v1/resolve/klipy?type=stickers&slug=nothing")).status, 404);
    fetchImpl = async () => new Response("nope", { status: 404 });
    assert.equal((await call("/v1/resolve/klipy?type=clips&slug=nothing")).status, 404);
    fetchImpl = async () => new Response("down", { status: 500 });
    const e = await call("/v1/resolve/klipy?type=memes&slug=x");
    assert.equal(e.status, 502);
    assert.doesNotMatch((await e.json()).error, /klipy-test-key/, "the API key never leaks into errors");
    fetchImpl = async () => new Response("<html>", { status: 200 });
    assert.equal((await call("/v1/resolve/klipy?type=gifs&slug=x")).status, 502);
  });

  it("normaliseKlipy accepts the item, list and nested-list shapes", () => {
    assert.deepEqual(normaliseKlipy({ result: true, data: ITEM }, "archer-jazz-hands"), NORMALISED);
    assert.deepEqual(normaliseKlipy({ result: true, data: [ITEM] }, "ARCHER-JAZZ-HANDS"), NORMALISED);
    assert.deepEqual(normaliseKlipy({ items: [{ ...ITEM, file: undefined, files: ITEM.file }] }, "x"), NORMALISED);
    assert.equal(normaliseKlipy({ data: { data: [{ slug: "x", file: { hd: { gif: { url: "http://insecure" } } } }] } }, "x"), null);
    assert.equal(normaliseKlipy(null, "x"), null);
    assert.equal(normaliseKlipy({ data: "nope" }, "x"), null);
  });
});
