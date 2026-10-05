import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { egressProxyUrl, loadConfig, loadEgressConfig, parseSize } from "../src/config.mjs";
import { childEnv, redactEgressToken } from "../src/egressClient.mjs";
import { JobManager, dirBytes, diskFreeBytes, formatBytes } from "../src/jobs.mjs";
import { silentLogger } from "../src/log.mjs";
import { tmpDir, waitFor } from "./helpers.mjs";

function cfg(dir, o = {}) {
  return {
    dataDir: dir,
    jobsDir: path.join(dir, "jobs"),
    maxConcurrentJobs: 1,
    maxQueue: 5,
    jobTtlMs: 30 * 60_000,
    jobTimeoutMs: 30 * 60_000,
    maxFilesizeBytes: 1e9,
    jobsPerKeyPerHour: 40,
    ytdlp: { cmd: "yt-dlp", prefixArgs: [] },
    ffmpegDir: "/usr/bin",
    egressProxyUrl: "http://127.0.0.1:8899",
    cookiesFile: path.join(dir, "cookies.txt"),
    sweepIntervalMs: 600_000,
    maxStagingBytes: 2e9,
    stagingPollMs: 2000,
    minFreeBytes: 0,
    ...o,
  };
}

/** A `run` that writes one output file and exits 0 — no real processes. */
function fakeRun(calls) {
  return ({ args }) => {
    calls.push(args);
    const home = args[args.indexOf("--paths") + 1].slice("home:".length);
    fs.writeFileSync(path.join(home, "Clip.mp4"), "data");
    return { cancel() {}, done: Promise.resolve({ code: 0, tail: "", stderr: "", timedOut: false, cancelled: false }) };
  };
}

describe("JobManager", () => {
  it("sweeps finished jobs after the TTL and stray dirs, keeps fresh ones", async () => {
    const dir = tmpDir();
    let t = 1_000_000;
    const calls = [];
    const jm = new JobManager({ config: cfg(dir), log: silentLogger, engine: null, run: fakeRun(calls), now: () => t });
    await jm.wipe();
    const job = jm.create({ url: "https://example.com/a", format: "mp4" }, { keyId: "k" });
    await waitFor(() => job.state === "done");
    assert.ok(fs.existsSync(job.filePath));

    const stray = path.join(dir, "jobs", "orphan");
    fs.mkdirSync(stray);

    t += 29 * 60_000;
    await jm.sweep();
    assert.ok(jm.get(job.id), "still inside the TTL");
    assert.ok(fs.existsSync(stray), "stray dir is fresh by mtime");

    t = Date.now() + 31 * 60_000;
    await jm.sweep();
    assert.equal(jm.get(job.id), null);
    assert.ok(!fs.existsSync(job.dir));
    assert.ok(!fs.existsSync(stray));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("holds new jobs while yt-dlp updates and starts them when it is idle", async () => {
    const dir = tmpDir();
    const listeners = [];
    const engine = { isUpdating: true, onIdle: (fn) => listeners.push(fn) };
    const calls = [];
    const jm = new JobManager({ config: cfg(dir), log: silentLogger, engine, run: fakeRun(calls) });
    await jm.wipe();
    const job = jm.create({ url: "https://example.com/a", format: "mp4" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(job.state, "queued");
    assert.equal(calls.length, 0);
    engine.isUpdating = false;
    for (const fn of listeners) fn();
    await waitFor(() => job.state === "done");
    assert.equal(calls.length, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tokens compare in constant time and only match exactly", async () => {
    const dir = tmpDir();
    const jm = new JobManager({ config: cfg(dir), log: silentLogger, engine: null, run: fakeRun([]) });
    await jm.wipe();
    const job = jm.create({ url: "https://example.com/a", format: "mp4" });
    assert.equal(jm.tokenMatches(job, job.token), true);
    assert.equal(jm.tokenMatches(job, job.token.toUpperCase()), false);
    assert.equal(jm.tokenMatches(job, job.token.slice(1)), false);
    assert.equal(jm.tokenMatches(job, ""), false);
    assert.equal(jm.tokenMatches(job, null), false);
    assert.equal(jm.tokenMatches(null, job.token), false);
    await waitFor(() => job.state === "done");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses new jobs while DATA_DIR is low on space (and doesn't count them)", async () => {
    const dir = tmpDir();
    let free = 5 * 1024 ** 3;
    const seen = [];
    const jm = new JobManager({
      config: cfg(dir, { minFreeBytes: 20 * 1024 ** 3, jobsPerKeyPerHour: 1 }),
      log: silentLogger,
      engine: null,
      run: fakeRun([]),
      freeBytes: (d) => {
        seen.push(d);
        return free;
      },
    });
    await jm.wipe();
    assert.throws(
      () => jm.create({ url: "https://example.com/a" }, { keyId: "k" }),
      (e) => e.status === 503 && /low on disk space/.test(e.message) && e.headers["retry-after"] === "600",
    );
    assert.equal(seen[0], dir, "free space is read on DATA_DIR");
    free = 21 * 1024 ** 3;
    const job = jm.create({ url: "https://example.com/a" }, { keyId: "k" });
    await waitFor(() => job.state === "done");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-checks free space when a queued job starts", async () => {
    const dir = tmpDir();
    let free = 50 * 1024 ** 3;
    const listeners = [];
    const engine = { isUpdating: true, onIdle: (fn) => listeners.push(fn) };
    const calls = [];
    const jm = new JobManager({
      config: cfg(dir, { minFreeBytes: 20 * 1024 ** 3 }),
      log: silentLogger,
      engine,
      run: fakeRun(calls),
      freeBytes: () => free,
    });
    await jm.wipe();
    const job = jm.create({ url: "https://example.com/a" });
    assert.equal(job.state, "queued");
    free = 1024 ** 3;
    engine.isUpdating = false;
    for (const fn of listeners) fn();
    await waitFor(() => job.state === "error");
    assert.match(job.error, /low on disk space/);
    assert.equal(calls.length, 0, "yt-dlp never started");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("MIN_FREE_GB=0 turns the guard off, and an unreadable statfs never blocks", async () => {
    const dir = tmpDir();
    const off = new JobManager({ config: cfg(dir), log: silentLogger, engine: null, freeBytes: () => 0 });
    assert.equal(off.hasFreeSpace(), true);
    const warnings = [];
    const broken = new JobManager({
      config: cfg(dir, { minFreeBytes: 1 }),
      log: { ...silentLogger, warn: (m) => warnings.push(m) },
      engine: null,
      freeBytes: () => {
        throw new Error("ENOSYS");
      },
    });
    assert.equal(broken.hasFreeSpace(), true);
    assert.deepEqual(warnings, ["could not read free disk space"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("diskFreeBytes reads the real filesystem", () => {
    const n = diskFreeBytes(os.tmpdir());
    assert.ok(Number.isFinite(n) && n > 0, String(n));
  });

  it("the staging watchdog stops a run that keeps writing past the cap", async () => {
    const dir = tmpDir();
    let cancelled = 0;
    // A fake yt-dlp that appends to a .part in tmp/ until cancelled.
    const run = ({ args }) => {
      const tmp = args[args.lastIndexOf("--paths") + 1].slice("temp:".length);
      let stop;
      const done = new Promise((resolve) => {
        const timer = setInterval(() => fs.appendFileSync(path.join(tmp, "stream.mp4.part"), Buffer.alloc(32 * 1024)), 5);
        stop = () => {
          clearInterval(timer);
          resolve({ code: 1, tail: "killed", stderr: "", timedOut: false, cancelled: true });
        };
      });
      return {
        cancel() {
          cancelled++;
          stop();
        },
        done,
      };
    };
    const warnings = [];
    const jm = new JobManager({
      config: cfg(dir, { maxFilesizeBytes: 100 * 1024, maxStagingBytes: 200 * 1024, stagingPollMs: 50 }),
      log: { ...silentLogger, warn: (m, f) => warnings.push([m, f]) },
      engine: null,
      run,
    });
    await jm.wipe();
    const job = jm.create({ url: "https://example.com/live.m3u8" });
    await waitFor(() => job.state === "error", { timeoutMs: 5000 });
    assert.equal(cancelled, 1);
    assert.equal(job.error, "This download is bigger than the server's size limit (100 KB) and was stopped.");
    assert.ok(!fs.existsSync(job.dir), "staging is deleted");
    assert.equal(warnings[0][0], "job over the staging cap, stopping it");
    assert.ok(warnings[0][1].bytes > 200 * 1024);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dirBytes sums files in nested dirs; formatBytes reads like MAX_FILESIZE", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "x"), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, "a", "y"), Buffer.alloc(20));
    fs.writeFileSync(path.join(dir, "a", "b", "z"), Buffer.alloc(30));
    assert.equal(await dirBytes(dir), 60);
    assert.equal(await dirBytes(path.join(dir, "missing")), 0);
    assert.equal(formatBytes(2 * 1024 ** 3), "2 GB");
    assert.equal(formatBytes(500 * 1024 ** 2), "500 MB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(512), "512 bytes");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the hourly window slides", async () => {
    const dir = tmpDir();
    let t = 5_000_000;
    const jm = new JobManager({
      config: cfg(dir, { jobsPerKeyPerHour: 1, maxConcurrentJobs: 4 }),
      log: silentLogger,
      engine: null,
      run: fakeRun([]),
      now: () => t,
    });
    await jm.wipe();
    jm.create({ url: "https://example.com/a" }, { keyId: "k" });
    assert.throws(() => jm.create({ url: "https://example.com/b" }, { keyId: "k" }), (e) => e.status === 429);
    t += 3600_001;
    assert.ok(jm.create({ url: "https://example.com/c" }, { keyId: "k" }));
    await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("config", () => {
  it("parseSize", () => {
    assert.equal(parseSize("2G"), 2 * 1024 ** 3);
    assert.equal(parseSize("500M"), 500 * 1024 ** 2);
    assert.equal(parseSize("1.5k"), 1536);
    assert.equal(parseSize("2GiB"), 2 * 1024 ** 3);
    assert.equal(parseSize("1048576"), 1048576);
    assert.equal(parseSize("lots"), null);
    assert.equal(parseSize("0"), null);
    assert.equal(parseSize(""), null);
  });

  it("requires a strong ORIGIN_KEY and accepts a rotation pair", () => {
    assert.throws(() => loadConfig({}), /ORIGIN_KEY/);
    assert.throws(() => loadConfig({ ORIGIN_KEY: "short" }), /ORIGIN_KEY/);
    assert.throws(() => loadConfig({ ORIGIN_KEY: `${"n".repeat(32)},short` }), /ORIGIN_KEY/);
    assert.deepEqual(loadConfig({ ORIGIN_KEY: ` ${"n".repeat(32)} , ${"o".repeat(32)} ` }).originKeys, [
      "n".repeat(32),
      "o".repeat(32),
    ]);
  });

  it("applies the documented defaults", () => {
    const c = loadConfig({ ORIGIN_KEY: "x".repeat(32), DATA_DIR: "/data" });
    assert.equal(c.port, 8080);
    assert.equal(c.maxConcurrentJobs, 2);
    assert.equal(c.maxQueue, 20);
    assert.equal(c.jobTtlMs, 30 * 60_000);
    assert.equal(c.jobTimeoutMs, 30 * 60_000);
    assert.equal(c.maxFilesizeBytes, 2 * 1024 ** 3);
    assert.equal(c.jobsPerKeyPerHour, 40);
    assert.equal(c.ytdlp.cmd, "/opt/ytdlp/bin/yt-dlp");
    assert.equal(c.pip.cmd, "/opt/ytdlp/bin/pip");
    assert.equal(c.ffmpegDir, "/usr/bin");
    assert.equal(c.egressProxyPort, 8899);
    assert.deepEqual(c.egressAllowedPorts, [80, 443, 8080, 8443]);
    assert.equal(path.basename(c.cookiesFile), "cookies.txt");
    assert.equal(c.autoUpdateHours, 24);
    // Egress: single-process dev mode unless compose says otherwise.
    assert.equal(c.egressMode, "inprocess");
    assert.equal(c.egressHost, "127.0.0.1");
    assert.equal(c.egressToken, "");
    assert.equal(c.egressProxyUrl, "http://127.0.0.1:8899");
    // Disk guards.
    assert.equal(c.maxStagingBytes, 4 * 1024 ** 3);
    assert.equal(c.stagingPollMs, 2000);
    assert.equal(c.minFreeBytes, 20 * 1024 ** 3);
  });

  it("EGRESS_MODE=remote points every child at the egress container, with the token", () => {
    const token = "a".repeat(64);
    const c = loadConfig({ ORIGIN_KEY: "x".repeat(32), EGRESS_MODE: "remote", EGRESS_TOKEN: token });
    assert.equal(c.egressMode, "remote");
    assert.equal(c.egressHost, "egress");
    assert.equal(c.egressToken, token);
    assert.equal(c.egressProxyUrl, `http://convertx:${token}@egress:8899`);
    const custom = loadConfig({ ORIGIN_KEY: "x".repeat(32), EGRESS_MODE: "REMOTE", EGRESS_HOST: "127.0.0.1", EGRESS_PROXY_PORT: "18899" });
    assert.equal(custom.egressProxyUrl, "http://127.0.0.1:18899");
    // inprocess ignores EGRESS_HOST: the proxy is always local then.
    assert.equal(loadConfig({ ORIGIN_KEY: "x".repeat(32), EGRESS_HOST: "egress" }).egressHost, "127.0.0.1");

    const env = childEnv(c);
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      assert.equal(env[k], c.egressProxyUrl, k);
    }
    assert.equal(env.NO_PROXY, "");
    assert.equal(redactEgressToken(`ERROR: via http://convertx:${token}@egress:8899 boom`, c), "ERROR: via http://convertx:***@egress:8899 boom");
    assert.equal(redactEgressToken("no token here", { egressToken: "" }), "no token here");
    assert.equal(egressProxyUrl({ host: "h", port: 1 }), "http://h:1");
  });

  it("validates the egress and disk settings", () => {
    const base = { ORIGIN_KEY: "x".repeat(32) };
    assert.throws(() => loadConfig({ ...base, EGRESS_MODE: "direct" }), /EGRESS_MODE/);
    assert.throws(() => loadConfig({ ...base, EGRESS_TOKEN: "short" }), /EGRESS_TOKEN/);
    assert.throws(() => loadConfig({ ...base, EGRESS_TOKEN: "x".repeat(20) + "@evil" }), /EGRESS_TOKEN/);
    assert.throws(() => loadConfig({ ...base, EGRESS_MODE: "remote", EGRESS_HOST: "bad host" }), /EGRESS_HOST/);
    assert.throws(() => loadConfig({ ...base, MIN_FREE_GB: "-1" }), /MIN_FREE_GB/);
    assert.equal(loadConfig({ ...base, MIN_FREE_GB: "0" }).minFreeBytes, 0);
    assert.equal(loadConfig({ ...base, MAX_FILESIZE: "500M" }).maxStagingBytes, 1000 * 1024 ** 2);
  });

  it("the egress process needs no API secrets", () => {
    const e = loadEgressConfig({});
    assert.deepEqual(e, { listenHost: "0.0.0.0", port: 8899, allowedPorts: [80, 443, 8080, 8443], token: "" });
    const t = loadEgressConfig({ EGRESS_TOKEN: "b".repeat(32), EGRESS_PROXY_PORT: "9000", EGRESS_LISTEN_HOST: "127.0.0.1" });
    assert.equal(t.token, "b".repeat(32));
    assert.equal(t.port, 9000);
    assert.equal(t.listenHost, "127.0.0.1");
  });

  it("rejects nonsense values loudly", () => {
    const base = { ORIGIN_KEY: "x".repeat(32) };
    assert.throws(() => loadConfig({ ...base, MAX_CONCURRENT_JOBS: "0" }), /MAX_CONCURRENT_JOBS/);
    assert.throws(() => loadConfig({ ...base, PORT: "http" }), /PORT/);
    assert.throws(() => loadConfig({ ...base, MAX_FILESIZE: "big" }), /MAX_FILESIZE/);
    assert.throws(() => loadConfig({ ...base, EGRESS_ALLOWED_PORTS: "443,abc" }), /EGRESS_ALLOWED_PORTS/);
  });
});
