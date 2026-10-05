// Environment → config. Every knob has a safe default except ORIGIN_KEY:
// without it the service would accept anyone who can reach it, so startup
// refuses instead.

import path from "node:path";

const SIZE_RE = /^(\d+(?:\.\d+)?)([kmgt])?i?b?$/i;
const UNITS = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** "2G" → 2147483648, "500M" → 524288000, "1048576" → 1048576. null if invalid. */
export function parseSize(value) {
  const m = String(value ?? "").trim().match(SIZE_RE);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? UNITS[m[2].toLowerCase()] : 1);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function int(env, key, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function str(env, key, def) {
  const raw = env[key];
  return raw === undefined || raw.trim() === "" ? def : raw.trim();
}

function portList(raw, key) {
  const ports = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!ports.length || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error(`${key} must be a comma-separated list of ports (got "${raw}")`);
  }
  return ports;
}

// URL userinfo-safe (it travels as http://convertx:<token>@egress:8899) and
// long enough to be a secret. `openssl rand -hex 32` fits.
const TOKEN_RE = /^[A-Za-z0-9._~-]{16,256}$/;
const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function egressToken(env) {
  const token = str(env, "EGRESS_TOKEN", "");
  if (token && !TOKEN_RE.test(token)) {
    throw new Error("EGRESS_TOKEN must be 16-256 characters from A-Z a-z 0-9 . _ ~ - (openssl rand -hex 32)");
  }
  return token;
}

function egressPort(env) {
  return int(env, "EGRESS_PROXY_PORT", 8899, { min: 1, max: 65535 });
}

function egressAllowedPorts(env) {
  return portList(str(env, "EGRESS_ALLOWED_PORTS", "80,443,8080,8443"), "EGRESS_ALLOWED_PORTS");
}

/**
 * The proxy URL every yt-dlp/ffmpeg/pip child gets (--proxy, HTTP(S)_PROXY).
 * The token rides as Basic credentials, which yt-dlp (requests/urllib),
 * ffmpeg (after the proxy's 407 challenge) and pip all send.
 */
export function egressProxyUrl({ host, port, token = "" }) {
  return `http://${token ? `convertx:${token}@` : ""}${host}:${port}`;
}

/**
 * Settings of the egress proxy process (src/egressMain.mjs). It needs none of
 * the API's secrets; EGRESS_TOKEN is the only one it shares with the API.
 */
export function loadEgressConfig(env = process.env) {
  return {
    listenHost: str(env, "EGRESS_LISTEN_HOST", "0.0.0.0"),
    port: egressPort(env),
    allowedPorts: egressAllowedPorts(env),
    token: egressToken(env),
  };
}

export function loadConfig(env = process.env) {
  // Comma-separated so a rotation can accept "new,old" for a moment.
  const originKeys = str(env, "ORIGIN_KEY", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!originKeys.length || originKeys.some((k) => k.length < 16)) {
    throw new Error("ORIGIN_KEY is required and every key must be at least 16 characters (openssl rand -hex 32)");
  }

  const maxFilesize = str(env, "MAX_FILESIZE", "2G");
  const maxFilesizeBytes = parseSize(maxFilesize);
  if (!maxFilesizeBytes) throw new Error(`MAX_FILESIZE is not a size like 2G or 500M (got "${maxFilesize}")`);

  const dataDir = path.resolve(str(env, "DATA_DIR", "/data"));
  const ytdlp = str(env, "YTDLP", "/opt/ytdlp/bin/yt-dlp");
  const pip = str(env, "PIP", "/opt/ytdlp/bin/pip");

  // inprocess: the proxy runs inside this process on 127.0.0.1 (dev, tests).
  // remote: it is the separate `egress` container; this one has no route out.
  const egressMode = str(env, "EGRESS_MODE", "inprocess").toLowerCase();
  if (egressMode !== "inprocess" && egressMode !== "remote") {
    throw new Error(`EGRESS_MODE must be "inprocess" or "remote" (got "${env.EGRESS_MODE}")`);
  }
  const egressHost = egressMode === "remote" ? str(env, "EGRESS_HOST", "egress") : "127.0.0.1";
  if (!HOSTNAME_RE.test(egressHost)) throw new Error(`EGRESS_HOST is not a host name (got "${egressHost}")`);
  const egress = { host: egressHost, port: egressPort(env), token: egressToken(env) };

  return {
    port: int(env, "PORT", 8080, { min: 1, max: 65535 }),
    host: str(env, "HOST", "0.0.0.0"),
    originKeys,
    dataDir,
    jobsDir: path.join(dataDir, "jobs"),
    maxConcurrentJobs: int(env, "MAX_CONCURRENT_JOBS", 2, { min: 1, max: 16 }),
    maxQueue: int(env, "MAX_QUEUE", 20, { min: 0, max: 500 }),
    jobTtlMs: int(env, "JOB_TTL_MIN", 30, { min: 1, max: 24 * 60 }) * 60_000,
    jobTimeoutMs: int(env, "JOB_TIMEOUT_MIN", 30, { min: 1, max: 6 * 60 }) * 60_000,
    // Bytes everywhere: yt-dlp's parse_bytes takes a plain integer, but not
    // every human form we accept here ("2GiB").
    maxFilesizeBytes,
    jobsPerKeyPerHour: int(env, "JOBS_PER_KEY_PER_HOUR", 40, { min: 1, max: 100_000 }),
    maxConcurrentProbes: int(env, "MAX_CONCURRENT_PROBES", 4, { min: 1, max: 32 }),
    probeTimeoutMs: int(env, "PROBE_TIMEOUT_SEC", 90, { min: 10, max: 900 }) * 1000,
    ytdlp: { cmd: ytdlp, prefixArgs: [] },
    pip: { cmd: pip, prefixArgs: [] },
    ffmpegDir: str(env, "FFMPEG_DIR", "/usr/bin"),
    egressMode,
    egressHost: egress.host,
    egressProxyPort: egress.port,
    egressToken: egress.token,
    egressProxyUrl: egressProxyUrl(egress),
    // Only the in-process proxy reads this; the egress container has its own copy.
    egressAllowedPorts: egressAllowedPorts(env),
    cookiesFile: str(env, "COOKIES_FILE", path.join(dataDir, "cookies.txt")),
    autoUpdateHours: int(env, "YTDLP_AUTO_UPDATE_HOURS", 24, { min: 0, max: 24 * 30 }),
    sweepIntervalMs: 10 * 60_000,
    // Disk guards. --max-filesize only works when the size is known up front
    // (not for live/HLS/chunked), so a watchdog sums each job's staging dir
    // and stops it past twice the cap (video + audio before the merge).
    maxStagingBytes: maxFilesizeBytes * 2,
    stagingPollMs: 2000,
    // No new jobs while DATA_DIR has less than this free (0 = off). /data
    // sits on the NAS pool other services share.
    minFreeBytes: int(env, "MIN_FREE_GB", 20, { min: 0, max: 1_000_000 }) * 1024 ** 3,
  };
}
