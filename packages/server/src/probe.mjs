// POST /probe — yt-dlp --dump-single-json, shaped into the desktop's
// ProbeResult (downloader.rs probe_url + parse_probe_json).
//
// Probes are short but CPU-heavy (yt-dlp spins up Python and, for YouTube,
// Node), so they share a small concurrency budget with a bounded wait line.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { childEnv, redactEgressToken } from "./egressClient.mjs";
import { HttpError, stageCookies, validateHttpUrl } from "./jobs.mjs";
import { runProcess } from "./proc.mjs";
import {
  buildProbeArgs,
  serverFriendlyError,
  hasCookies,
  isSpotifyUrl,
  isYoutubeUrl,
  parseProbeJson,
  stripCookieArgs,
  ytdlpLostFormats,
} from "./ytdlp.mjs";

function semaphore(limit, maxWaiting) {
  let active = 0;
  const waiting = [];
  return {
    async acquire() {
      if (active < limit) {
        active++;
        return;
      }
      if (waiting.length >= maxWaiting) {
        throw new HttpError(503, "The downloader is busy — try again in a minute.", { "retry-after": "30" });
      }
      await new Promise((resolve) => waiting.push(resolve));
    },
    release() {
      const next = waiting.shift();
      if (next) next();
      else active--;
    },
  };
}

export function createProber({ config, log, engine, run = runProcess }) {
  const slots = semaphore(config.maxConcurrentProbes, config.maxConcurrentProbes * 4);

  function exec(args, signal) {
    const handle = run({
      cmd: config.ytdlp.cmd,
      args: [...config.ytdlp.prefixArgs, ...args],
      env: childEnv(config),
      timeoutMs: config.probeTimeoutMs,
      collectStdout: true,
      maxStdoutBytes: 128 * 1024 * 1024,
    });
    // The caller hung up: no one will read the answer, so stop yt-dlp.
    const onAbort = () => handle.cancel();
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    return handle.done.finally(() => signal?.removeEventListener("abort", onAbort));
  }

  async function probe(rawUrl, { signal } = {}) {
    const url = validateHttpUrl(rawUrl);
    if (isSpotifyUrl(url)) {
      throw new HttpError(422, "Spotify links aren't supported by the web downloader — use the desktop app.");
    }
    await engine?.whenIdle();
    await slots.acquire();
    const scratch = path.join(config.dataDir, "probe", crypto.randomBytes(8).toString("hex"));
    try {
      await fsp.mkdir(scratch, { recursive: true });
      const cookiesPath = await stageCookies(config, path.join(scratch, "cookies.txt"));
      const args = buildProbeArgs(url, { cookiesPath, proxyUrl: config.egressProxyUrl });
      const r = await exec(args, signal);

      if (r.cancelled) throw new HttpError(499, "Probe cancelled");
      if (r.spawnError) {
        log.error("yt-dlp failed to start", { detail: r.spawnError.message });
        throw new HttpError(500, `Failed to start yt-dlp (${config.ytdlp.cmd}): ${r.spawnError.message}`);
      }
      if (r.timedOut) throw new HttpError(504, "Reading this link took too long — try again, or try a direct video link.");
      if (r.stdoutOverflow) throw new HttpError(422, "This link lists too much to preview.");

      if (r.code !== 0) {
        const detail = r.tail ? redactEgressToken(r.tail, config) : "(no details)";
        if (hasCookies(cookiesPath) && isYoutubeUrl(url) && ytdlpLostFormats(r.stderr)) {
          const r2 = await exec(stripCookieArgs(args, cookiesPath), signal);
          if (r2.code === 0 && !r2.timedOut) {
            try {
              return parseProbeJson(JSON.parse(r2.stdout));
            } catch {
              /* fall through to the original error */
            }
          }
        }
        throw new HttpError(422, serverFriendlyError(detail, r.code, redactEgressToken(r.stderr, config)));
      }

      let json;
      try {
        json = JSON.parse(r.stdout);
      } catch (e) {
        throw new HttpError(502, `Couldn't parse yt-dlp metadata: ${e.message}`);
      }
      return parseProbeJson(json);
    } finally {
      slots.release();
      fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  return { probe };
}
