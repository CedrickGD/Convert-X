// Download jobs: queue → yt-dlp → one finished file served by token.
//
// Cloudflare cuts a request that sends no bytes for ~100 s, and a yt-dlp
// download + merge easily takes longer, so the web client never waits on one
// long request: it creates a job, polls GET /jobs/:id, then fetches
// /jobs/:id/file?t=<token> as a plain browser download.
//
// Lifecycle: queued → running → done | error | cancelled. Each job owns
// <DATA_DIR>/jobs/<id>/{out,tmp}; yt-dlp writes there exactly like the
// desktop's per-job staging dir, and the primary output is picked the same
// way (downloader.rs move_staging_outputs). Finished jobs live for
// JOB_TTL_MIN, then the sweeper deletes them and their files.
//
// Disk: /data is on the NAS pool other services share, and --max-filesize
// only works when yt-dlp knows the size up front. So every running job has a
// watchdog that sums its staging dir every few seconds and stops it past
// MAX_FILESIZE x 2; a finished file over MAX_FILESIZE is refused; and no job
// starts while DATA_DIR has less than MIN_FREE_GB free.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { childEnv, redactEgressToken } from "./egressClient.mjs";
import { runProcess } from "./proc.mjs";
import {
  LIVE_SKIPPED_RE,
  buildServerYtdlpArgs,
  collectStagingFiles,
  formatElapsed,
  serverFriendlyError,
  hasCookies,
  isYoutubeUrl,
  parseYtdlpProgress,
  pickPrimaryOutput,
  titleFromPath,
  ytdlpLostFormats,
} from "./ytdlp.mjs";

export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

const HOUR = 3600_000;

const LOW_DISK = "The downloader is low on disk space — try again later.";
const LIVE = "This is a live stream. The web downloader only saves videos that have ended.";

/** Free bytes for unprivileged users on the filesystem holding `dir`. */
export function diskFreeBytes(dir) {
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

/** Bytes of every regular file under `dir` (no symlinks followed); 0 if it's gone. */
export async function dirBytes(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      total += await dirBytes(p);
    } else if (d.isFile()) {
      try {
        total += (await fsp.lstat(p)).size;
      } catch {
        /* finished/renamed between readdir and lstat */
      }
    }
  }
  return total;
}

/** 2147483648 → "2 GB", 524288000 → "500 MB" (binary units, the way MAX_FILESIZE is read). */
export function formatBytes(n) {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : Number(v.toFixed(v < 10 ? 1 : 0))} ${units[i]}`;
}

function tooLarge(cfg) {
  return `This download is bigger than the server's size limit (${formatBytes(cfg.maxFilesizeBytes)}) and was stopped.`;
}

/** Copy the master cookies.txt for one run (yt-dlp rewrites the jar it is given). */
export async function stageCookies(config, destFile) {
  try {
    const st = await fsp.stat(config.cookiesFile);
    if (!st.isFile() || st.size === 0) return null;
    await fsp.copyFile(config.cookiesFile, destFile);
    return destFile;
  } catch {
    return null;
  }
}

function describeDuration(ms) {
  if (ms >= 60_000) {
    const m = Math.round(ms / 60_000);
    return `${m} minute${m === 1 ? "" : "s"}`;
  }
  const sec = Math.max(1, Math.round(ms / 1000));
  return `${sec} second${sec === 1 ? "" : "s"}`;
}

function newId() {
  return crypto.randomBytes(12).toString("base64url");
}

export class JobManager {
  constructor({ config, log, engine, run = runProcess, now = () => Date.now(), freeBytes = diskFreeBytes }) {
    this.config = config;
    this.log = log;
    this.engine = engine;
    this.run = run;
    this.now = now;
    this.freeBytes = freeBytes;
    this.jobs = new Map();
    this.queue = [];
    this.running = new Set();
    this.keyWindows = new Map();
    this.sweepTimer = null;
    this.closed = false;
    engine?.onIdle?.(() => this.pump());
  }

  stats() {
    return { running: this.running.size, queued: this.queue.length };
  }

  /** False when DATA_DIR has less than MIN_FREE_GB free. A failing statfs never blocks. */
  hasFreeSpace() {
    const min = this.config.minFreeBytes;
    if (!min) return true;
    let free;
    try {
      free = this.freeBytes(this.config.dataDir);
    } catch (e) {
      this.log.warn("could not read free disk space", { detail: e.message });
      return true;
    }
    if (free >= min) return true;
    this.log.warn("low disk space, refusing jobs", { freeBytes: free, minFreeBytes: min });
    return false;
  }

  /** Validate + enqueue. Throws HttpError on bad input / limits. */
  create(input, { keyId = "unknown", clientIp = null } = {}) {
    if (this.closed) throw new HttpError(503, "The downloader is restarting — try again in a moment.");
    const opts = validateJobInput(input);
    if (!this.hasFreeSpace()) throw new HttpError(503, LOW_DISK, { "retry-after": "600" });

    const t = this.now();
    const window = (this.keyWindows.get(keyId) || []).filter((ts) => t - ts < HOUR);
    if (window.length >= this.config.jobsPerKeyPerHour) {
      const retry = Math.max(1, Math.ceil((window[0] + HOUR - t) / 1000));
      this.keyWindows.set(keyId, window);
      throw new HttpError(429, "Hourly download limit reached for this key — try again later.", {
        "retry-after": String(retry),
      });
    }
    const slotFree = this.running.size < this.config.maxConcurrentJobs && !this.engine?.isUpdating;
    if (!slotFree && this.queue.length >= this.config.maxQueue) {
      throw new HttpError(503, "The downloader is busy — try again in a minute.", { "retry-after": "60" });
    }
    window.push(t);
    this.keyWindows.set(keyId, window);

    const job = {
      id: newId(),
      token: crypto.randomBytes(32).toString("hex"),
      keyId,
      clientIp,
      opts,
      state: "queued",
      progress: 0,
      stage: "queued",
      error: null,
      fileName: null,
      filePath: null,
      size: null,
      title: null,
      createdAt: t,
      startedAt: null,
      finishedAt: null,
      handle: null,
      cancelRequested: false,
      sizeExceeded: false,
      liveSkipped: false,
    };
    job.dir = path.join(this.config.jobsDir, job.id);
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.log.info("job queued", { jobId: job.id, keyId, format: opts.format, quality: opts.quality });
    this.pump();
    return job;
  }

  get(id) {
    return typeof id === "string" ? this.jobs.get(id) || null : null;
  }

  view(job) {
    const end = job.finishedAt ?? this.now();
    return {
      jobId: job.id,
      state: job.state,
      progress: job.progress,
      stage: job.stage,
      elapsed: job.startedAt ? formatElapsed(end - job.startedAt) : "00:00",
      error: job.error,
      fileName: job.fileName,
      size: job.size,
      title: job.title,
    };
  }

  /** Constant-time token check (hash first so lengths never leak). */
  tokenMatches(job, token) {
    if (!job || typeof token !== "string" || !token) return false;
    const a = crypto.createHash("sha256").update(job.token).digest();
    const b = crypto.createHash("sha256").update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  pump() {
    if (this.closed || this.engine?.isUpdating) return;
    while (this.running.size < this.config.maxConcurrentJobs && this.queue.length) {
      const job = this.queue.shift();
      if (job.state !== "queued") continue;
      this.running.add(job);
      this.execute(job)
        .catch((e) => {
          this.log.error("job crashed", { jobId: job.id, detail: e?.message });
          if (job.state === "running") this.finish(job, "error", { error: "Download failed unexpectedly." });
        })
        .finally(() => {
          this.running.delete(job);
          this.pump();
        });
    }
  }

  /**
   * Sum the job's staging dir every `stagingPollMs`; past `maxStagingBytes`
   * flag the job and stop yt-dlp. Returns the stop function.
   */
  startWatchdog(job) {
    const cap = this.config.maxStagingBytes;
    if (!cap) return () => {};
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || job.sizeExceeded) return;
      busy = true;
      try {
        const bytes = await dirBytes(job.dir);
        if (bytes > cap && !job.sizeExceeded) {
          job.sizeExceeded = true;
          this.log.warn("job over the staging cap, stopping it", { jobId: job.id, bytes, cap });
          job.handle?.cancel();
        }
      } catch (e) {
        this.log.warn("staging watchdog failed", { jobId: job.id, detail: e.message });
      } finally {
        busy = false;
      }
    }, this.config.stagingPollMs || 2000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async execute(job) {
    const cfg = this.config;
    job.state = "running";
    job.stage = "fetching";
    job.startedAt = this.now();
    // Space may have run out while this job waited in the queue.
    if (!this.hasFreeSpace()) return this.finish(job, "error", { error: LOW_DISK });
    const out = path.join(job.dir, "out");
    const tmp = path.join(job.dir, "tmp");
    await fsp.rm(job.dir, { recursive: true, force: true });
    await fsp.mkdir(out, { recursive: true });
    await fsp.mkdir(tmp, { recursive: true });

    const cookiesPath = await stageCookies(cfg, path.join(job.dir, "cookies.txt"));
    const opts = { ...job.opts, cookiesPath };
    const env = childEnv(cfg);
    const deadline = job.startedAt + cfg.jobTimeoutMs;

    const onLine = (line) => {
      if (LIVE_SKIPPED_RE.test(line)) job.liveSkipped = true;
      const p = parseYtdlpProgress(line);
      if (!p || job.state !== "running") return;
      job.progress = p[0];
      job.stage = p[1];
    };
    const runOnce = (o) => {
      if (job.cancelRequested || job.sizeExceeded) return null;
      const handle = this.run({
        cmd: cfg.ytdlp.cmd,
        args: [...cfg.ytdlp.prefixArgs, ...buildServerYtdlpArgs(o, out, tmp, cfg)],
        env,
        timeoutMs: Math.max(1000, deadline - this.now()),
        onStdoutLine: onLine,
      });
      job.handle = handle;
      return handle.done;
    };

    const stopWatchdog = this.startWatchdog(job);
    let r;
    try {
      r = await runOnce(opts);
      // Same stale-cookie-jar rescue as the desktop: YouTube can hand a jar it
      // dislikes nothing but storyboards; public videos still work anonymously.
      if (
        r !== null &&
        !job.cancelRequested &&
        !job.sizeExceeded &&
        r.code !== 0 &&
        !r.timedOut &&
        !r.spawnError &&
        hasCookies(opts.cookiesPath) &&
        isYoutubeUrl(opts.url) &&
        ytdlpLostFormats(r.tail)
      ) {
        const second = await runOnce({ ...opts, cookiesPath: null });
        if (second === null) r = null;
        else if (second.code === 0) r = second;
      }
    } finally {
      stopWatchdog();
    }
    job.handle = null;
    if (job.cancelRequested) return this.finishCancelled(job);
    if (job.sizeExceeded) {
      await this.removeDir(job);
      return this.finish(job, "error", { error: tooLarge(cfg) });
    }
    if (r === null) return this.finishCancelled(job);

    if (r.spawnError) {
      await this.removeDir(job);
      return this.finish(job, "error", { error: `Failed to start yt-dlp (${cfg.ytdlp.cmd}): ${r.spawnError.message}` });
    }
    if (r.timedOut) {
      await this.removeDir(job);
      return this.finish(job, "error", {
        error: `The download took longer than ${describeDuration(cfg.jobTimeoutMs)} and was stopped.`,
      });
    }
    if (r.code !== 0) {
      await this.removeDir(job);
      const detail = r.tail ? redactEgressToken(r.tail, cfg) : "(no details)";
      return this.finish(job, "error", { error: serverFriendlyError(detail, r.code, redactEgressToken(r.stderr, cfg)) });
    }

    const files = [];
    for (const p of collectStagingFiles(out)) {
      try {
        files.push({ path: p, size: fs.statSync(p).size });
      } catch {
        /* vanished between readdir and stat */
      }
    }
    const primary = pickPrimaryOutput(files, opts.format);
    if (!primary) {
      await this.removeDir(job);
      return this.finish(job, "error", {
        error: job.liveSkipped ? LIVE : "Download finished but no output file was produced.",
      });
    }
    // A fast transfer can finish between two watchdog polls.
    if (primary.size > cfg.maxFilesizeBytes) {
      await this.removeDir(job);
      return this.finish(job, "error", { error: tooLarge(cfg) });
    }
    // Only the primary file is ever served; drop everything else now
    // (secondary outputs, .part leftovers of a retried attempt).
    const keep = path.basename(primary.path);
    const leftovers = await fsp.readdir(out).catch(() => []);
    await Promise.all(
      leftovers.filter((n) => n !== keep).map((n) => fsp.rm(path.join(out, n), { recursive: true, force: true })),
    );
    await fsp.rm(tmp, { recursive: true, force: true });
    if (cookiesPath) await fsp.rm(cookiesPath, { force: true });

    return this.finish(job, "done", {
      filePath: primary.path,
      fileName: path.basename(primary.path),
      size: primary.size,
      title: titleFromPath(primary.path),
    });
  }

  finish(job, state, fields = {}) {
    if (job.state === "cancelled" && state !== "cancelled") return;
    Object.assign(job, fields);
    job.state = state;
    job.finishedAt = this.now();
    job.handle = null;
    if (state === "done") {
      job.progress = 100;
      job.stage = "done";
    }
    this.log.info("job finished", {
      jobId: job.id,
      state,
      ms: job.startedAt ? job.finishedAt - job.startedAt : 0,
      size: job.size ?? undefined,
      error: job.error ?? undefined,
    });
  }

  async finishCancelled(job) {
    job.handle = null;
    await this.removeDir(job);
    if (job.state !== "cancelled") this.finish(job, "cancelled");
  }

  /**
   * Cancel a queued/running job, or discard a finished one (deletes its
   * file). Returns the job's view, or null when unknown.
   */
  async cancel(id) {
    const job = this.get(id);
    if (!job) return null;
    if (job.state === "queued") {
      this.queue = this.queue.filter((j) => j !== job);
      job.cancelRequested = true;
      this.finish(job, "cancelled");
      return this.view(job);
    }
    if (job.state === "running") {
      job.cancelRequested = true;
      const handle = job.handle;
      // Report it now; the runner cleans the staging dir once the process
      // group is gone (SIGTERM, SIGKILL after the grace period).
      this.finish(job, "cancelled");
      handle?.cancel();
      return this.view(job);
    }
    const v = this.view(job);
    this.jobs.delete(job.id);
    await this.removeDir(job);
    return { ...v, removed: true };
  }

  async removeDir(job) {
    try {
      await fsp.rm(job.dir, { recursive: true, force: true });
    } catch (e) {
      this.log.warn("could not remove job dir", { jobId: job.id, detail: e.message });
    }
  }

  /** Drop expired finished jobs and stray directories. */
  async sweep() {
    const t = this.now();
    for (const job of [...this.jobs.values()]) {
      if (job.finishedAt && t - job.finishedAt > this.config.jobTtlMs && !this.running.has(job)) {
        this.jobs.delete(job.id);
        await this.removeDir(job);
      }
    }
    for (const [key, list] of this.keyWindows) {
      const kept = list.filter((ts) => t - ts < HOUR);
      if (kept.length) this.keyWindows.set(key, kept);
      else this.keyWindows.delete(key);
    }
    let entries = [];
    try {
      entries = await fsp.readdir(this.config.jobsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (this.jobs.has(d.name)) continue;
      const p = path.join(this.config.jobsDir, d.name);
      try {
        const st = await fsp.stat(p);
        if (t - st.mtimeMs > this.config.jobTtlMs) await fsp.rm(p, { recursive: true, force: true });
      } catch {
        /* raced with another delete */
      }
    }
  }

  /** At boot nothing in jobs/ belongs to a live job. */
  async wipe() {
    await fsp.rm(this.config.jobsDir, { recursive: true, force: true });
    await fsp.mkdir(this.config.jobsDir, { recursive: true });
  }

  startSweeper() {
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((e) => this.log.warn("sweep failed", { detail: e.message }));
    }, this.config.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Stop accepting work and kill every running process group. */
  async shutdown(graceMs = 6000) {
    this.closed = true;
    clearInterval(this.sweepTimer);
    for (const job of this.queue) this.finish(job, "cancelled");
    this.queue = [];
    for (const job of this.running) {
      job.cancelRequested = true;
      job.handle?.cancel();
    }
    const until = Date.now() + graceMs;
    while (this.running.size > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

// ── input validation ────────────────────────────────────────────────────────

const FORMAT_RE = /^[a-z0-9]{1,10}$/;
const ITEMS_RE = /^[0-9,:\- ]{1,200}$/;

export function validateHttpUrl(raw, field = "url") {
  if (typeof raw !== "string" || !raw.trim()) throw new HttpError(400, `Missing ${field}`);
  const s = raw.trim();
  if (s.length > 4096) throw new HttpError(400, `${field} is too long`);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, `${field} is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, `${field} must be an http(s) URL`);
  return s;
}

export function validateJobInput(input) {
  if (!input || typeof input !== "object") throw new HttpError(400, "Expected a JSON object");
  const url = validateHttpUrl(input.url);
  if (/open\.spotify\.com\/|^spotify:/i.test(url)) {
    throw new HttpError(422, "Spotify links aren't supported by the web downloader — use the desktop app.");
  }
  const format = String(input.format ?? "mp4").toLowerCase();
  if (!FORMAT_RE.test(format)) throw new HttpError(400, "Invalid format");
  const quality = String(input.quality ?? "best");
  if (quality.length > 10) throw new HttpError(400, "Invalid quality");
  let playlistItems = null;
  if (input.playlistItems != null && String(input.playlistItems).trim() !== "") {
    playlistItems = String(input.playlistItems);
    if (!ITEMS_RE.test(playlistItems)) throw new HttpError(400, "Invalid playlistItems");
  }
  return {
    url,
    format,
    quality,
    playlistItems,
    noPlaylist: input.noPlaylist === true,
    dedupeNames: input.dedupeNames === true,
  };
}
