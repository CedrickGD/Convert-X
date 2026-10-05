// End-to-end over HTTP against the real app, with test/fixtures/fake-ytdlp.mjs
// standing in for yt-dlp and fake-pip.mjs for pip.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.mjs";
import { createEngine } from "../src/engine.mjs";
import { JobManager } from "../src/jobs.mjs";
import { silentLogger } from "../src/log.mjs";
import { createProber } from "../src/probe.mjs";
import { createSafeFetcher } from "../src/safeFetch.mjs";
import { FFMPEG_INPUT_ARGS, parseProbeJson } from "../src/ytdlp.mjs";
import { FIXTURES, fixture, pidAlive, sleep, startProxy, startServer, tmpDir, waitFor } from "./helpers.mjs";

const KEY = "test-origin-key-0123456789abcdef";
// A second accepted key, as during an ORIGIN_KEY rotation ("new,old").
const OLD_KEY = "previous-origin-key-fedcba9876543210";
const FAKE_YTDLP = path.join(FIXTURES, "fake-ytdlp.mjs");
const FAKE_PIP = path.join(FIXTURES, "fake-pip.mjs");

// One state dir for the whole file: every child inherits process.env.
const STATE = tmpDir("convertx-fake-state-");
process.env.FAKE_YTDLP_STATE = STATE;

function makeConfig(dir, overrides = {}) {
  return {
    port: 0,
    host: "127.0.0.1",
    originKeys: [KEY, OLD_KEY],
    dataDir: dir,
    jobsDir: path.join(dir, "jobs"),
    maxConcurrentJobs: 2,
    maxQueue: 4,
    jobTtlMs: 60_000,
    jobTimeoutMs: 60_000,
    maxFilesizeBytes: 50 * 1024 * 1024,
    jobsPerKeyPerHour: 100,
    maxConcurrentProbes: 2,
    probeTimeoutMs: 20_000,
    ytdlp: { cmd: process.execPath, prefixArgs: [FAKE_YTDLP] },
    pip: { cmd: process.execPath, prefixArgs: [FAKE_PIP] },
    ffmpegDir: "/usr/bin",
    egressMode: "remote",
    egressHost: "127.0.0.1",
    egressProxyPort: 18899,
    egressToken: "",
    egressProxyUrl: "http://127.0.0.1:18899",
    egressAllowedPorts: [80, 443],
    cookiesFile: path.join(dir, "cookies.txt"),
    autoUpdateHours: 0,
    sweepIntervalMs: 600_000,
    maxStagingBytes: 100 * 1024 * 1024,
    stagingPollMs: 2000,
    minFreeBytes: 0,
    ...overrides,
  };
}

async function startApp(overrides = {}, { fetcher = null, freeBytes } = {}) {
  const dir = tmpDir();
  const config = makeConfig(dir, overrides);
  const engine = createEngine({ config, log: silentLogger });
  await engine.refreshVersion();
  const jobs = new JobManager({ config, log: silentLogger, engine, ...(freeBytes ? { freeBytes } : {}) });
  await jobs.wipe();
  const prober = createProber({ config, log: silentLogger, engine });
  const handler = createApp({
    config,
    log: silentLogger,
    jobs,
    engine,
    prober,
    // Nothing listens there: suites that use the outbound routes pass their own.
    fetcher: fetcher || createSafeFetcher({ proxy: { host: "127.0.0.1", port: config.egressProxyPort } }),
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    config,
    jobs,
    dir,
    async close() {
      await jobs.shutdown(3000);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const authed = (extra = {}) => ({ "x-convertx-origin-key": KEY, ...extra });
const json = (body, extra = {}) => ({
  method: "POST",
  headers: authed({ "content-type": "application/json", ...extra }),
  body: JSON.stringify(body),
});

async function call(base, p, init = {}) {
  const res = await fetch(base + p, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

async function waitJob(base, id, states = ["done", "error", "cancelled"]) {
  return waitFor(async () => {
    const r = await call(base, `/jobs/${id}`, { headers: authed() });
    return states.includes(r.body.state) ? r.body : null;
  }, { timeoutMs: 20_000 });
}

function lastArgs() {
  const files = fs.readdirSync(STATE).filter((f) => /^args-\d+\.json$/.test(f));
  const n = Math.max(...files.map((f) => Number(f.match(/\d+/)[0])));
  return JSON.parse(fs.readFileSync(path.join(STATE, `args-${n}.json`), "utf8"));
}

function argsCount() {
  return fs.readdirSync(STATE).filter((f) => /^args-\d+\.json$/.test(f)).length;
}

after(() => fs.rmSync(STATE, { recursive: true, force: true }));

describe("auth, health and routing", () => {
  let app;
  before(async () => (app = await startApp()));
  after(() => app.close());

  it("GET /health is public and reports the engine + queue", async () => {
    const r = await call(app.base, "/health");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, service: "convertx-api", ytdlp: "2026.01.01", running: 0, queued: 0 });
  });

  it("every other route needs the origin key", async () => {
    for (const [p, init] of [
      ["/probe", { method: "POST", body: "{}" }],
      ["/jobs", { method: "POST", body: "{}" }],
      ["/jobs/abc", {}],
      ["/direct?url=https://cdn.discordapp.com/x.png", {}],
      ["/engine/update", { method: "POST" }],
      ["/nope", {}],
    ]) {
      const r = await call(app.base, p, init);
      assert.equal(r.status, 401, p);
      assert.deepEqual(r.body, { error: "Unauthorized" });
    }
    const wrong = await call(app.base, "/jobs/abc", { headers: { "x-convertx-origin-key": KEY.slice(0, -1) + "X" } });
    assert.equal(wrong.status, 401);
    const shorter = await call(app.base, "/jobs/abc", { headers: { "x-convertx-origin-key": KEY.slice(0, 8) } });
    assert.equal(shorter.status, 401);
    const empty = await call(app.base, "/jobs/abc", { headers: { "x-convertx-origin-key": "" } });
    assert.equal(empty.status, 401);
  });

  it("accepts every key of a rotation pair", async () => {
    for (const k of [KEY, OLD_KEY]) {
      const r = await call(app.base, "/jobs/abc", { headers: { "x-convertx-origin-key": k } });
      assert.equal(r.status, 404, "authorized → the job lookup runs");
    }
    const both = await call(app.base, "/jobs/abc", { headers: { "x-convertx-origin-key": `${KEY},${OLD_KEY}` } });
    assert.equal(both.status, 401);
  });

  it("unknown routes are 404, wrong methods 405 (with the key)", async () => {
    assert.equal((await call(app.base, "/nope", { headers: authed() })).status, 404);
    assert.equal((await call(app.base, "/probe", { headers: authed() })).status, 405);
    assert.equal((await call(app.base, "/jobs", { headers: authed() })).status, 405);
    assert.equal((await call(app.base, "/jobs/abc", { method: "PUT", headers: authed() })).status, 405);
    assert.equal((await call(app.base, "/jobs/abc", { headers: authed() })).status, 404);
    assert.equal((await call(app.base, "/jobs/a%20b", { headers: authed() })).status, 404);
  });

  it("rejects malformed JSON bodies", async () => {
    const r = await call(app.base, "/probe", { method: "POST", headers: authed(), body: "{not json" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "Invalid JSON body");
  });
});

describe("POST /probe", () => {
  let app;
  before(async () => (app = await startApp()));
  after(() => app.close());

  it("returns the desktop ProbeResult shape", async () => {
    const r = await call(app.base, "/probe", json({ url: "https://www.youtube.com/watch?v=ok" }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, parseProbeJson(JSON.parse(fixture("probe-youtube.json"))));
  });

  it("maps yt-dlp failures to the friendly desktop copy", async () => {
    const r = await call(app.base, "/probe", json({ url: "https://example.com/fail" }));
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "This URL isn't supported. Try the desktop site URL instead of mobile/share links.");
  });

  it("rejects bad input and Spotify", async () => {
    assert.equal((await call(app.base, "/probe", json({}))).status, 400);
    assert.equal((await call(app.base, "/probe", json({ url: "ftp://x/y" }))).status, 400);
    assert.equal((await call(app.base, "/probe", json({ url: "javascript:alert(1)" }))).status, 400);
    const s = await call(app.base, "/probe", json({ url: "https://open.spotify.com/track/1" }));
    assert.equal(s.status, 422);
    assert.match(s.body.error, /Spotify/);
  });

  it("reports unparseable metadata", async () => {
    const r = await call(app.base, "/probe", json({ url: "https://example.com/garbage" }));
    assert.equal(r.status, 502);
    assert.match(r.body.error, /^Couldn't parse yt-dlp metadata/);
  });

  it("retries a YouTube probe without cookies when the jar loses formats", async () => {
    fs.writeFileSync(app.config.cookiesFile, "# Netscape HTTP Cookie File\n");
    try {
      const r = await call(app.base, "/probe", json({ url: "https://www.youtube.com/watch?v=lost" }));
      assert.equal(r.status, 200);
      assert.equal(r.body.title, "Me at the zoo");
    } finally {
      fs.rmSync(app.config.cookiesFile, { force: true });
    }
  });

  it("stops yt-dlp when the caller hangs up", async () => {
    const pidFile = path.join(STATE, "pid-hang");
    fs.rmSync(pidFile, { force: true });
    const ac = new AbortController();
    const pending = fetch(app.base + "/probe", { ...json({ url: "https://example.com/hang" }), signal: ac.signal }).catch(
      () => null,
    );
    const pid = Number(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8")));
    assert.ok(pidAlive(pid));
    ac.abort();
    await pending;
    await waitFor(() => !pidAlive(pid), { timeoutMs: 10_000 });
  });
});

describe("jobs", () => {
  let app;
  before(async () => (app = await startApp()));
  after(() => app.close());

  it("runs a job end to end: queue → progress → done → file by token → discard", async () => {
    const created = await call(
      app.base,
      "/jobs",
      json({ url: "https://www.youtube.com/watch?v=ok", format: "mp4", quality: "720" }, { "x-convertx-key-id": "alice" }),
    );
    assert.equal(created.status, 202);
    const { jobId, token } = created.body;
    assert.match(jobId, /^[A-Za-z0-9_-]{16}$/);
    assert.match(token, /^[0-9a-f]{64}$/);

    const done = await waitJob(app.base, jobId);
    assert.equal(done.state, "done");
    assert.equal(done.progress, 100);
    assert.equal(done.stage, "done");
    assert.equal(done.fileName, "Fake Title.mp4");
    assert.equal(done.size, 5000);
    assert.equal(done.title, "Fake Title");
    assert.equal(done.error, null);
    assert.match(done.elapsed, /^\d{2}:\d{2}$/);

    // The exact argv the desktop would build, plus the server additions.
    const args = lastArgs();
    const out = path.join(app.config.jobsDir, jobId, "out");
    assert.equal(args[0], "https://www.youtube.com/watch?v=ok");
    assert.deepEqual(args.slice(1, 7), ["-o", "%(title).180B.%(ext)s", "--paths", `home:${out}`, "--paths", `temp:${path.join(app.config.jobsDir, jobId, "tmp")}`]);
    assert.ok(args.includes("--no-playlist"));
    assert.ok(!args.includes("--cookies"));
    assert.deepEqual(args.slice(-10), [
      "--js-runtimes",
      "node",
      "--max-filesize",
      String(50 * 1024 * 1024),
      "--match-filters",
      "!is_live",
      "--downloader-args",
      FFMPEG_INPUT_ARGS,
      "--proxy",
      "http://127.0.0.1:18899",
    ]);

    // Only the primary file is kept.
    assert.deepEqual(fs.readdirSync(out), ["Fake Title.mp4"]);
    assert.ok(!fs.existsSync(path.join(app.config.jobsDir, jobId, "tmp")));

    // File: token-gated, no origin key needed.
    assert.equal((await call(app.base, `/jobs/${jobId}/file`)).status, 404);
    assert.equal((await call(app.base, `/jobs/${jobId}/file?t=${"0".repeat(64)}`)).status, 404);
    assert.equal((await call(app.base, `/jobs/nope/file?t=${token}`)).status, 404);
    const file = await fetch(`${app.base}/jobs/${jobId}/file?t=${token}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "video/mp4");
    assert.equal(file.headers.get("content-length"), "5000");
    assert.equal(file.headers.get("accept-ranges"), "bytes");
    assert.equal(file.headers.get("content-disposition"), `attachment; filename="Fake Title.mp4"; filename*=UTF-8''Fake%20Title.mp4`);
    const bytes = Buffer.from(await file.arrayBuffer());
    assert.equal(bytes.length, 5000);
    assert.ok(bytes.every((b) => b === 7));

    // Ranges.
    const part = await fetch(`${app.base}/jobs/${jobId}/file?t=${token}`, { headers: { range: "bytes=0-99" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 0-99/5000");
    assert.equal((await part.arrayBuffer()).byteLength, 100);
    const suffix = await fetch(`${app.base}/jobs/${jobId}/file?t=${token}`, { headers: { range: "bytes=-10" } });
    assert.equal(suffix.headers.get("content-range"), "bytes 4990-4999/5000");
    await suffix.arrayBuffer();
    const bad = await fetch(`${app.base}/jobs/${jobId}/file?t=${token}`, { headers: { range: "bytes=6000-" } });
    assert.equal(bad.status, 416);
    await bad.arrayBuffer();

    // Discard.
    const del = await call(app.base, `/jobs/${jobId}`, { method: "DELETE", headers: authed() });
    assert.equal(del.status, 200);
    assert.equal(del.body.removed, true);
    assert.equal((await call(app.base, `/jobs/${jobId}`, { headers: authed() })).status, 404);
    assert.ok(!fs.existsSync(path.join(app.config.jobsDir, jobId)));
  });

  it("audio + non-ASCII file names", async () => {
    const { body } = await call(app.base, "/jobs", json({ url: "https://www.youtube.com/watch?v=unicode", format: "mp3" }));
    const done = await waitJob(app.base, body.jobId);
    assert.equal(done.fileName, "Zoë – ünïcode 🎉.mp3");
    const args = lastArgs();
    assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 7), [
      "-f",
      "bestaudio/best",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
    ]);
    const file = await fetch(`${app.base}/jobs/${body.jobId}/file?t=${body.token}`);
    assert.equal(file.headers.get("content-type"), "audio/mpeg");
    assert.equal(
      file.headers.get("content-disposition"),
      `attachment; filename="Zoe  unicode.mp3"; filename*=UTF-8''Zo%C3%AB%20%E2%80%93%20%C3%BCn%C3%AFcode%20%F0%9F%8E%89.mp3`,
    );
    await file.arrayBuffer();
  });

  it("surfaces yt-dlp errors with the desktop wording and cleans up", async () => {
    const { body } = await call(app.base, "/jobs", json({ url: "https://example.com/fail", format: "mp4" }));
    const done = await waitJob(app.base, body.jobId);
    assert.equal(done.state, "error");
    assert.equal(done.error, "This URL isn't supported. Try the desktop site URL instead of mobile/share links.");
    assert.ok(!fs.existsSync(path.join(app.config.jobsDir, body.jobId)));
    assert.equal((await call(app.base, `/jobs/${body.jobId}/file?t=${body.token}`)).status, 409);
  });

  it("a run that writes nothing is an error", async () => {
    const { body } = await call(app.base, "/jobs", json({ url: "https://example.com/empty", format: "mp4" }));
    const done = await waitJob(app.base, body.jobId);
    assert.equal(done.error, "Download finished but no output file was produced.");
  });

  it("retries a YouTube download without cookies on lost formats", async () => {
    fs.writeFileSync(app.config.cookiesFile, "# Netscape HTTP Cookie File\n");
    try {
      const before = argsCount();
      const { body } = await call(app.base, "/jobs", json({ url: "https://www.youtube.com/watch?v=lost", format: "mp4" }));
      const done = await waitJob(app.base, body.jobId);
      assert.equal(done.state, "done");
      assert.equal(argsCount(), before + 2);
      const first = JSON.parse(fs.readFileSync(path.join(STATE, `args-${before}.json`), "utf8"));
      const second = JSON.parse(fs.readFileSync(path.join(STATE, `args-${before + 1}.json`), "utf8"));
      // The jar is a per-job copy, never the master file.
      assert.equal(first[first.indexOf("--cookies") + 1], path.join(app.config.jobsDir, body.jobId, "cookies.txt"));
      assert.ok(!second.includes("--cookies"));
    } finally {
      fs.rmSync(app.config.cookiesFile, { force: true });
    }
  });

  it("reports progress while running, then cancels the process group", async () => {
    for (const f of ["pid-family", "child-family"]) fs.rmSync(path.join(STATE, f), { force: true });
    const { body } = await call(app.base, "/jobs", json({ url: "https://example.com/family", format: "mp4" }));
    const running = await waitFor(async () => {
      const r = await call(app.base, `/jobs/${body.jobId}`, { headers: authed() });
      return r.body.state === "running" && r.body.progress > 0 ? r.body : null;
    });
    assert.equal(running.stage, "downloading");
    const pid = Number(await waitFor(() => fs.existsSync(path.join(STATE, "pid-family")) && fs.readFileSync(path.join(STATE, "pid-family"), "utf8")));
    const child = Number(await waitFor(() => fs.existsSync(path.join(STATE, "child-family")) && fs.readFileSync(path.join(STATE, "child-family"), "utf8")));
    assert.ok(pidAlive(pid) && pidAlive(child));

    const del = await call(app.base, `/jobs/${body.jobId}`, { method: "DELETE", headers: authed() });
    assert.equal(del.status, 200);
    assert.equal(del.body.state, "cancelled");
    await waitFor(() => !pidAlive(pid) && !pidAlive(child), { timeoutMs: 12_000 });
    await waitFor(() => !fs.existsSync(path.join(app.config.jobsDir, body.jobId)));
    const after = await call(app.base, `/jobs/${body.jobId}`, { headers: authed() });
    assert.equal(after.body.state, "cancelled");
  });

  it("validates job input", async () => {
    for (const bad of [
      {},
      { url: "nope" },
      { url: "https://x.test/a", format: "../../etc" },
      { url: "https://x.test/a", playlistItems: "1;rm -rf" },
      { url: "https://x.test/a", quality: "x".repeat(20) },
    ]) {
      assert.equal((await call(app.base, "/jobs", json(bad))).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call(app.base, "/jobs", json({ url: "https://open.spotify.com/track/1" }))).status, 422);
  });
});

describe("job limits", () => {
  it("enforces the per-key hourly budget", async () => {
    const app = await startApp({ jobsPerKeyPerHour: 2 });
    try {
      const mk = (key) => call(app.base, "/jobs", json({ url: "https://example.com/ok", format: "mp4" }, { "x-convertx-key-id": key }));
      assert.equal((await mk("alice")).status, 202);
      assert.equal((await mk("alice")).status, 202);
      const third = await mk("alice");
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers.get("retry-after")) > 0);
      assert.equal((await mk("bob")).status, 202);
    } finally {
      await app.close();
    }
  });

  it("queues past the concurrency limit and refuses past the queue limit", async () => {
    const app = await startApp({ maxConcurrentJobs: 1, maxQueue: 1 });
    try {
      const a = await call(app.base, "/jobs", json({ url: "https://example.com/slow", format: "mp4" }));
      const b = await call(app.base, "/jobs", json({ url: "https://example.com/slow", format: "mp4" }));
      assert.equal(a.status, 202);
      assert.equal(b.status, 202);
      assert.equal((await call(app.base, `/jobs/${b.body.jobId}`, { headers: authed() })).body.state, "queued");
      const health = await call(app.base, "/health");
      assert.equal(health.body.running, 1);
      assert.equal(health.body.queued, 1);
      const c = await call(app.base, "/jobs", json({ url: "https://example.com/slow", format: "mp4" }));
      assert.equal(c.status, 503);
      assert.equal(c.headers.get("retry-after"), "60");

      const cq = await call(app.base, `/jobs/${b.body.jobId}`, { method: "DELETE", headers: authed() });
      assert.equal(cq.body.state, "cancelled");
      await call(app.base, `/jobs/${a.body.jobId}`, { method: "DELETE", headers: authed() });
      await waitFor(async () => (await call(app.base, "/health")).body.running === 0);
    } finally {
      await app.close();
    }
  });

  it("stops a job at the hard timeout", async () => {
    const app = await startApp({ jobTimeoutMs: 1500 });
    try {
      const { body } = await call(app.base, "/jobs", json({ url: "https://example.com/slow", format: "mp4" }));
      const done = await waitJob(app.base, body.jobId);
      assert.equal(done.state, "error");
      assert.equal(done.error, "The download took longer than 2 seconds and was stopped.");
    } finally {
      await app.close();
    }
  });
});

describe("POST /engine/update", () => {
  let app;
  before(async () => {
    for (const f of ["version", "pip-noop", "pip-fail"]) fs.rmSync(path.join(STATE, f), { force: true });
    app = await startApp();
  });
  after(async () => {
    for (const f of ["version", "pip-noop", "pip-fail"]) fs.rmSync(path.join(STATE, f), { force: true });
    await app.close();
  });

  it("updates, reports the new version, then says already up to date", async () => {
    const r = await call(app.base, "/engine/update", { method: "POST", headers: authed() });
    assert.deepEqual(r.body, { status: "DONE", version: "2026.09.30" });
    assert.equal((await call(app.base, "/health")).body.ytdlp, "2026.09.30");
    fs.writeFileSync(path.join(STATE, "pip-noop"), "");
    const again = await call(app.base, "/engine/update", { method: "POST", headers: authed() });
    assert.deepEqual(again.body, { status: "ALREADY_UP_TO_DATE", version: "2026.09.30" });
  });

  it("reports pip failures", async () => {
    fs.writeFileSync(path.join(STATE, "pip-fail"), "");
    const r = await call(app.base, "/engine/update", { method: "POST", headers: authed() });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /^The yt-dlp update failed: ERROR: Could not find a version/);
  });
});

describe("outbound routes (/http, /direct, /image)", () => {
  const EGRESS_TOKEN = "routes-egress-token-0123456789";
  let app;
  let upstream;
  let egress;
  const seen = [];

  before(async () => {
    upstream = await startServer(async (req, res) => {
      seen.push({ url: req.url, ua: req.headers["user-agent"], cookie: req.headers.cookie, host: req.headers.host });
      const p = new URL(req.url, "http://x").pathname;
      if (p === "/json") {
        res.writeHead(200, [
          ["Content-Type", "application/json"],
          ["Set-Cookie", "a=1"],
          ["Set-Cookie", "b=2"],
        ]);
        return res.end('{"a":1}');
      }
      if (p === "/bytes") {
        res.writeHead(200, { "content-type": "image/png", "content-length": 1000 });
        return res.end(Buffer.alloc(1000, 3));
      }
      if (p === "/html") return res.writeHead(200, { "content-type": "text/html" }).end("<p>hi</p>");
      if (p === "/slow") {
        await sleep(3000);
        return res.end("late");
      }
      if (p === "/short") {
        res.writeHead(200, { "content-type": "video/mp4", "content-length": 1000 });
        res.write(Buffer.alloc(10));
        return setTimeout(() => res.socket.destroy(), 50);
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("This content is no longer available.");
    });
    // The routes reach the upstream only through a real egress proxy with
    // scripted DNS, as they do through the egress container in production.
    egress = await startProxy(
      {
        "pbs.twimg.com": ["127.0.0.1"],
        "cdn.discordapp.com": ["127.0.0.1"],
        "thumbs.example": ["127.0.0.1"],
        "lan.example": ["192.168.2.201"],
        "media.tenor.com": ["10.0.0.3"],
      },
      { token: EGRESS_TOKEN, allowedPorts: [upstream.port] },
    );
    const fetcher = createSafeFetcher({
      proxy: { host: "127.0.0.1", port: egress.port, token: EGRESS_TOKEN },
      allowedPorts: [upstream.port],
    });
    app = await startApp({}, { fetcher });
  });
  after(async () => {
    await app.close();
    await egress.close();
    await upstream.close();
  });

  it("everything went through the egress proxy", async () => {
    const before = egress.allowed.length;
    const r = await call(app.base, "/http", json({ url: U("pbs.twimg.com", "/json") }));
    assert.equal(r.status, 200);
    assert.equal(egress.allowed.length, before + 1);
    assert.deepEqual(egress.allowed.at(-1), { kind: "GET", target: `pbs.twimg.com:${upstream.port}` });
    assert.equal(egress.authFailures.length, 0);
  });

  const U = (host, p) => `http://${host}:${upstream.port}${p}`;

  it("/http mirrors net.rs: any status resolves, headers lowercased and joined", async () => {
    const r = await call(
      app.base,
      "/http",
      json({ url: U("pbs.twimg.com", "/json"), headers: { "User-Agent": "Probe/1", Cookie: "sid=1", Host: "evil" } }),
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 200);
    assert.equal(r.body.body, '{"a":1}');
    assert.equal(r.body.headers["set-cookie"], "a=1, b=2");
    assert.equal(r.body.headers["content-type"], "application/json");
    assert.equal(seen.at(-1).ua, "Probe/1");
    assert.equal(seen.at(-1).cookie, "sid=1");
    assert.equal(seen.at(-1).host, `pbs.twimg.com:${upstream.port}`);

    const missing = await call(app.base, "/http", json({ url: U("cdn.discordapp.com", "/gone") }));
    assert.equal(missing.status, 200);
    assert.equal(missing.body.status, 404);
    assert.equal(missing.body.body, "This content is no longer available.");
  });

  it("/http enforces the host allowlist, the SSRF guard and the timeout wording", async () => {
    const notListed = await call(app.base, "/http", json({ url: U("thumbs.example", "/json") }));
    assert.equal(notListed.status, 403);
    const privateAnswer = await call(app.base, "/http", json({ url: U("media.tenor.com", "/x") }));
    assert.equal(privateAnswer.status, 403);
    assert.match(privateAnswer.body.error, /private/);
    const slow = await call(app.base, "/http", json({ url: U("pbs.twimg.com", "/slow"), timeoutMs: 1000 }));
    assert.equal(slow.status, 504);
    assert.equal(slow.body.error, "Request timed out after 1000ms");
    assert.equal((await call(app.base, "/http", json({ url: U("pbs.twimg.com", "/json"), method: "DELETE" }))).status, 400);
    assert.equal((await call(app.base, "/http", json({ url: U("pbs.twimg.com", "/json"), headers: { "Bad Header": "x" } }))).status, 400);
    assert.equal((await call(app.base, "/http", json({ url: U("pbs.twimg.com", "/json"), headers: { "X-A": "a\r\nb" } }))).status, 400);
  });

  it("/direct streams with Content-Disposition and passes statuses through", async () => {
    const ok = await fetch(`${app.base}/direct?url=${encodeURIComponent(U("cdn.discordapp.com", "/bytes"))}&name=${encodeURIComponent("my sticker.png")}`, {
      headers: authed(),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-upstream-status"), "200");
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("content-length"), "1000");
    assert.equal(ok.headers.get("content-disposition"), `attachment; filename="my sticker.png"; filename*=UTF-8''my%20sticker.png`);
    assert.equal(ok.headers.get("x-final-url"), U("cdn.discordapp.com", "/bytes"));
    assert.equal((await ok.arrayBuffer()).byteLength, 1000);

    const gone = await fetch(`${app.base}/direct?url=${encodeURIComponent(U("cdn.discordapp.com", "/expired"))}`, { headers: authed() });
    assert.equal(gone.status, 404);
    assert.equal(gone.headers.get("x-upstream-status"), "404");
    await gone.arrayBuffer();

    const blocked = await fetch(`${app.base}/direct?url=${encodeURIComponent(U("thumbs.example", "/bytes"))}`, { headers: authed() });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("x-upstream-status"), null);
    await blocked.arrayBuffer();
  });

  it("/direct never passes a truncated body off as complete", async () => {
    const r = await fetch(`${app.base}/direct?url=${encodeURIComponent(U("cdn.discordapp.com", "/short"))}`, { headers: authed() });
    assert.equal(r.status, 200);
    await assert.rejects(r.arrayBuffer());
  });

  it("/image serves images from any public host and refuses the rest", async () => {
    const ok = await fetch(`${app.base}/image?url=${encodeURIComponent(U("thumbs.example", "/bytes"))}`, { headers: authed() });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    await ok.arrayBuffer();
    const html = await call(app.base, `/image?url=${encodeURIComponent(U("thumbs.example", "/html"))}`, { headers: authed() });
    assert.equal(html.status, 415);
    const lan = await call(app.base, `/image?url=${encodeURIComponent(U("lan.example", "/bytes"))}`, { headers: authed() });
    assert.equal(lan.status, 403);
    const literal = await call(app.base, `/image?url=${encodeURIComponent("http://169.254.169.254/latest/meta-data")}`, {
      headers: authed(),
    });
    assert.equal(literal.status, 403);
    const literalSamePort = await call(app.base, `/image?url=${encodeURIComponent(`http://192.168.2.1:${upstream.port}/x.png`)}`, {
      headers: authed(),
    });
    assert.equal(literalSamePort.status, 403);
    assert.match(literalSamePort.body.error, /private/, "classified by the proxy");
  });

  it("an rtsp:// URL never gets as far as yt-dlp or the proxy", async () => {
    const before = egress.calls.length;
    for (const p of ["/jobs", "/probe", "/http"]) {
      const r = await call(app.base, p, json({ url: "rtsp://192.168.2.50:554/stream", format: "mp4" }));
      assert.equal(r.status, 400, p);
      assert.match(r.body.error, /http\(s\) URL/);
    }
    assert.equal(egress.calls.length, before);
  });
});

describe("disk and stream guards", () => {
  it("stops a job whose staging keeps growing past the cap (no size up front)", async () => {
    const app = await startApp({ maxFilesizeBytes: 256 * 1024, maxStagingBytes: 512 * 1024, stagingPollMs: 100 });
    try {
      fs.rmSync(path.join(STATE, "pid-flood"), { force: true });
      const { body } = await call(app.base, "/jobs", json({ url: "https://example.com/flood", format: "mp4" }));
      const done = await waitJob(app.base, body.jobId);
      assert.equal(done.state, "error");
      assert.equal(done.error, "This download is bigger than the server's size limit (256 KB) and was stopped.");
      const pid = Number(fs.readFileSync(path.join(STATE, "pid-flood"), "utf8"));
      await waitFor(() => !pidAlive(pid), { timeoutMs: 12_000 });
      assert.ok(!fs.existsSync(path.join(app.config.jobsDir, body.jobId)), "staging deleted");
      assert.equal((await call(app.base, `/jobs/${body.jobId}/file?t=${body.token}`)).status, 409);
    } finally {
      await app.close();
    }
  });

  it("refuses a finished file bigger than MAX_FILESIZE", async () => {
    const app = await startApp({ maxFilesizeBytes: 100 * 1024 });
    try {
      const { body } = await call(app.base, "/jobs", json({ url: "https://example.com/huge", format: "mp4" }));
      const done = await waitJob(app.base, body.jobId);
      assert.equal(done.state, "error");
      assert.equal(done.error, "This download is bigger than the server's size limit (100 KB) and was stopped.");
      assert.ok(!fs.existsSync(path.join(app.config.jobsDir, body.jobId)));
    } finally {
      await app.close();
    }
  });

  it("says so when the !is_live filter skipped a live stream", async () => {
    const app = await startApp();
    try {
      const { body } = await call(app.base, "/jobs", json({ url: "https://example.com/live", format: "mp4" }));
      const done = await waitJob(app.base, body.jobId);
      assert.equal(done.state, "error");
      assert.equal(done.error, "This is a live stream. The web downloader only saves videos that have ended.");
      const args = lastArgs();
      assert.equal(args[args.indexOf("--match-filters") + 1], "!is_live");
      assert.equal(args[args.indexOf("--downloader-args") + 1], FFMPEG_INPUT_ARGS);
    } finally {
      await app.close();
    }
  });

  it("answers 503 to new jobs while DATA_DIR is low on space", async () => {
    let free = 1024 ** 3;
    const app = await startApp({ minFreeBytes: 20 * 1024 ** 3 }, { freeBytes: () => free });
    try {
      const r = await call(app.base, "/jobs", json({ url: "https://example.com/ok", format: "mp4" }));
      assert.equal(r.status, 503);
      assert.equal(r.headers.get("retry-after"), "600");
      assert.equal(r.body.error, "The downloader is low on disk space — try again later.");
      free = 30 * 1024 ** 3;
      const ok = await call(app.base, "/jobs", json({ url: "https://example.com/ok", format: "mp4" }));
      assert.equal(ok.status, 202);
      assert.equal((await waitJob(app.base, ok.body.jobId)).state, "done");
    } finally {
      await app.close();
    }
  });

  it("never echoes EGRESS_TOKEN back in a job error", async () => {
    const token = "secret-egress-token-0123456789abcdef";
    const app = await startApp({ egressToken: token, egressProxyUrl: `http://convertx:${token}@127.0.0.1:18899` });
    try {
      const { body } = await call(app.base, "/jobs", json({ url: "https://example.com/leak", format: "mp4" }));
      const done = await waitJob(app.base, body.jobId);
      assert.equal(done.state, "error");
      assert.ok(!done.error.includes(token), done.error);
      assert.match(done.error, /convertx:\*\*\*@127\.0\.0\.1:18899/);
      const args = lastArgs();
      assert.equal(args[args.indexOf("--proxy") + 1], `http://convertx:${token}@127.0.0.1:18899`);
    } finally {
      await app.close();
    }
  });
});
