// yt-dlp argument building, output parsing and probe-result shaping.
//
// This is a line-for-line port of packages/desktop/src-tauri/src/downloader.rs
// (build_video_selector, build_ytdlp_args, parse_ytdlp_progress,
// friendly_error, collect_staging_files, expected_exts, the primary-output
// pick of move_staging_outputs, parse_probe_json / classify_entry and the
// YouTube lost-formats predicates). The web build talks to this service and
// must get exactly what the desktop app gets for the same URL, so when the
// Rust changes, change this file with it — test/ytdlp.test.mjs pins the
// shared behaviour.
//
// Server-only additions live in buildServerYtdlpArgs/buildProbeArgs and never
// alter the ported part: the egress proxy, a file-size cap, no live streams,
// an ffmpeg input-protocol whitelist, the Node JS runtime for YouTube, and a
// byte cap on the title in the output template (Linux file names are 255
// BYTES; Windows counts characters).

import fs from "node:fs";
import path from "node:path";

export const AUDIO_FORMATS = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"];
export const VIDEO_FORMATS = ["mp4", "mkv", "webm", "avi", "mov"];

export const isAudioFormat = (f) => AUDIO_FORMATS.includes(f);
export const isVideoFormat = (f) => VIDEO_FORMATS.includes(f);

export function isSpotifyUrl(url) {
  const lower = String(url).trim().toLowerCase();
  return lower.includes("open.spotify.com/") || lower.startsWith("spotify:");
}

export function hasCookies(cookiesPath) {
  return typeof cookiesPath === "string" && cookiesPath.trim() !== "";
}

export function isYoutubeUrl(url) {
  const low = String(url).toLowerCase();
  return low.includes("youtube.com") || low.includes("youtu.be");
}

/** yt-dlp's two ways of saying "the extractor returned nothing playable". */
export function ytdlpLostFormats(tail) {
  return tail.includes("No video formats found") || tail.includes("Requested format is not available");
}

/** Port of build_video_selector — every fallback term requires a video codec. */
export function buildVideoSelector(quality, format) {
  const extPair = format === "mp4" ? ["mp4", "m4a"] : format === "webm" ? ["webm", "webm"] : null;
  const h = quality === "1080" || quality === "720" || quality === "480" ? quality : null;
  if (h === null && extPair) {
    const [ve, ae] = extPair;
    return (
      `best[ext=${ve}][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/` +
      `bv*[ext=${ve}]+ba[ext=${ae}]/bv*+ba/bv*[ext=${ve}]/bv*`
    );
  }
  if (h === null) return "best[acodec!=none][vcodec!=none]/bv*+ba/bv*";
  if (extPair) {
    const [ve, ae] = extPair;
    return (
      `best[height<=${h}][ext=${ve}][acodec!=none][vcodec!=none]/` +
      `best[height<=${h}][acodec!=none][vcodec!=none]/` +
      `bv*[height<=${h}][ext=${ve}]+ba[ext=${ae}]/bv*[height<=${h}]+ba/bv*+ba/` +
      `best[acodec!=none][vcodec!=none]/bv*[height<=${h}]/bv*`
    );
  }
  return (
    `best[height<=${h}][acodec!=none][vcodec!=none]/` +
    `bv*[height<=${h}]+ba/bv*+ba/best[acodec!=none][vcodec!=none]/bv*[height<=${h}]/bv*`
  );
}

/**
 * Port of build_ytdlp_args. `opts` = {url, format, quality, playlistItems,
 * noPlaylist, dedupeNames, cookiesPath}.
 */
export function buildYtdlpArgs(opts, stagingOut, stagingTmp, ffmpegPath) {
  const isImage = opts.format === "image";
  const pinItem =
    typeof opts.playlistItems === "string" && opts.playlistItems.trim() !== "" ? opts.playlistItems : null;

  const args = [
    opts.url,
    "-o",
    opts.dedupeNames ? "%(title)s-%(id)s.%(ext)s" : "%(title)s.%(ext)s",
    "--paths",
    `home:${stagingOut}`,
    "--paths",
    `temp:${stagingTmp}`,
    "--newline",
    "--no-warnings",
    "--no-colors",
    "--ffmpeg-location",
    String(ffmpegPath),
    "--embed-metadata",
  ];

  if (hasCookies(opts.cookiesPath)) {
    args.push("--cookies", opts.cookiesPath);
  }

  if (pinItem) {
    args.push("--playlist-items", pinItem);
  } else {
    // Both the explicit request and the historical default end here: a plain
    // single-item download never expands into a whole playlist.
    args.push("--no-playlist");
  }

  if (isImage) {
    args.push("-f", "best");
  } else if (isAudioFormat(opts.format)) {
    args.push("--embed-thumbnail");
    args.push("-f", "bestaudio/best", "-x", "--audio-format", opts.format, "--audio-quality", "0");
  } else if (isVideoFormat(opts.format)) {
    args.push("--embed-thumbnail");
    args.push("-f", buildVideoSelector(opts.quality, opts.format), "--merge-output-format", opts.format);
  } else {
    // Unknown format — fall back to mp4 with the requested quality.
    args.push("--embed-thumbnail");
    args.push("-f", buildVideoSelector(opts.quality, "mp4"), "--merge-output-format", "mp4");
  }
  return args;
}

/** Title byte cap for the -o template (255-byte file names on Linux). */
const TITLE_BYTES = 180;

/**
 * Protocols ffmpeg may open for a download yt-dlp hands it (non-native HLS,
 * live DASH, rtmp_ffmpeg …): exactly what HTTP(S) through the egress proxy
 * needs — http/https, the tcp/tls under them, httpproxy for the CONNECT
 * tunnel, crypto for AES-128 HLS, data for inline manifests.
 * rtsp/rtmp/mms/udp/… would bypass the proxy (it only speaks HTTP), file
 * would read the container's own disk, and pipe is only used for websocket
 * live streams, which the !is_live filter skips anyway.
 * Not airtight: tcp/httpproxy stay allowed, so a `tcp://` / `httpproxy://`
 * input (or an `httpproxy://` HLS segment) is still dialled directly; the api
 * container's internal-only compose network is what contains those.
 */
export const FFMPEG_INPUT_PROTOCOLS = "crypto,data,http,https,tcp,tls,httpproxy";

/**
 * Demuxers ffmpeg may use for those inputs (and, via the HLS/DASH demuxers,
 * for their segments): the manifests plus the container/elementary formats
 * HLS and DASH carry, and mp4/webm for yt-dlp's section downloads. The
 * protocol whitelist alone is not enough: ffmpeg implements RTSP (and
 * RTP/SAP/SDP) as demuxers picked from the URL scheme that open a raw `tcp`
 * connection themselves — and `tcp` has to stay allowed for http. With this
 * list an rtsp:// input is refused before any socket opens.
 */
export const FFMPEG_INPUT_FORMATS = "hls,dash,mpegts,mov,matroska,flv,aac,mp3,ac3,eac3,webvtt,ogg,wav,flac";

/**
 * yt-dlp's ffmpeg downloader puts `--downloader-args ffmpeg_i:…` right before
 * EVERY `-i <url>` it emits (downloader/external.py FFmpegFD →
 * _configuration_args(("_i1", "_i"))). Post-processors (merge, extract
 * audio, thumbnails) only ever read local files and are not affected.
 */
export const FFMPEG_INPUT_ARGS =
  `ffmpeg_i:-protocol_whitelist ${FFMPEG_INPUT_PROTOCOLS} -format_whitelist ${FFMPEG_INPUT_FORMATS}`;

/** yt-dlp's stdout line for an entry the !is_live match filter skipped. */
export const LIVE_SKIPPED_RE = /does not pass filter \(!is_live\)/;

/**
 * The server's full yt-dlp argv: the ported args plus the size cap, the live
 * stream filter, the ffmpeg protocol whitelist, the egress proxy and — for
 * YouTube — the Node JS runtime yt-dlp needs to solve player challenges.
 * `cfg.egressProxyUrl` may carry EGRESS_TOKEN as Basic credentials.
 */
export function buildServerYtdlpArgs(opts, stagingOut, stagingTmp, cfg) {
  const args = buildYtdlpArgs(opts, stagingOut, stagingTmp, cfg.ffmpegDir);
  const o = args.indexOf("-o");
  args[o + 1] = args[o + 1].replace("%(title)s", `%(title).${TITLE_BYTES}B`);
  if (isYoutubeUrl(opts.url)) args.push("--js-runtimes", "node");
  // --max-filesize only bites when the size is known before downloading; the
  // job runner's staging watchdog covers the rest.
  args.push("--max-filesize", String(cfg.maxFilesizeBytes));
  // A live stream never ends and has no size: skip it (the runner reports it).
  args.push("--match-filters", "!is_live");
  args.push("--downloader-args", FFMPEG_INPUT_ARGS);
  args.push("--proxy", cfg.egressProxyUrl);
  return args;
}

/** Port of probe_url's argv (+ the runtime and proxy server additions). */
export function buildProbeArgs(url, { cookiesPath = null, proxyUrl = null } = {}) {
  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--skip-download",
    "--socket-timeout",
    "15",
    "--playlist-end",
    "50",
  ];
  if (hasCookies(cookiesPath)) args.push("--cookies", cookiesPath);
  if (isYoutubeUrl(url)) args.push("--js-runtimes", "node");
  if (proxyUrl) args.push("--proxy", proxyUrl);
  args.push(url);
  return args;
}

/** The probe retry argv: the original minus `--cookies <path>` (Rust filters both tokens). */
export function stripCookieArgs(args, cookiesPath) {
  const out = args.filter((a) => a !== "--cookies" && a !== cookiesPath);
  // Rust's Vec::dedup — drop consecutive duplicates.
  return out.filter((a, i) => i === 0 || a !== out[i - 1]);
}

/** Rust's `str::parse::<f64>()`: decimal/exponent, inf/infinity/nan; no junk. */
function parseRustF64(raw) {
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return Number(raw);
  const m = raw.match(/^([+-]?)(inf|infinity|nan)$/i);
  if (!m) return null;
  if (m[2].toLowerCase() === "nan") return NaN;
  return m[1] === "-" ? -Infinity : Infinity;
}

/** Port of parse_ytdlp_progress → [progress, stage] | null. */
export function parseYtdlpProgress(line) {
  const trimmed = String(line).trimStart();
  if (trimmed.startsWith("[download]")) {
    const pctEnd = trimmed.indexOf("%");
    if (pctEnd >= 0) {
      const prefix = trimmed.slice(0, pctEnd);
      let numStart = 0;
      for (let i = prefix.length - 1; i >= 0; i--) {
        if (/\s/.test(prefix[i])) {
          numStart = i + 1;
          break;
        }
      }
      const pct = parseRustF64(prefix.slice(numStart).trim());
      // f64::min ignores a NaN operand, so NaN → 100 like in Rust.
      if (pct !== null) return [Number.isNaN(pct) ? 100 : Math.min(pct, 100), "downloading"];
    }
  } else if (trimmed.startsWith("[Merger]") || trimmed.startsWith("[ExtractAudio]")) {
    return [99, "merging"];
  } else if (
    trimmed.startsWith("[info]") ||
    trimmed.startsWith("[youtube]") ||
    trimmed.startsWith("[generic]") ||
    trimmed.startsWith("[twitter]") ||
    trimmed.startsWith("[Instagram]") ||
    trimmed.startsWith("[TikTok]")
  ) {
    return [1, "fetching"];
  }
  return null;
}

/** Port of crate::ffmpeg::push_tail_line — keep the last 3 non-empty lines. */
export function pushTailLine(tail, line) {
  const t = String(line).trim();
  if (!t) return;
  if (tail.length === 3) tail.shift();
  tail.push(t);
}

/** Port of friendly_error. */
export function friendlyError(detail, exitCode) {
  const low = String(detail).toLowerCase();
  if (low.includes("rate/request limit") || (low.includes("rate limit") && low.includes("spotify"))) {
    return (
      "Spotify's free API quota is used up (shared across all spotdl users). " +
      "Either wait ~24h, or set your own Spotify Client ID + Secret " +
      "(free, 5-min signup at developer.spotify.com — paste them in Settings)."
    );
  }
  if (low.includes("rate-limit reached") || (low.includes("login required") && low.includes("instagram"))) {
    return (
      "Instagram blocked the request — either rate-limited, or the post is " +
      "private/login-only. Public Reels usually work; private posts need cookies."
    );
  }
  if (low.includes("unavailable") || low.includes("video unavailable")) {
    return "This video is unavailable (private, removed, or region-locked).";
  }
  if (low.includes("sign in") || low.includes("login required") || low.includes("age-restricted")) {
    return "This content requires sign-in or age verification — not supported without cookies.";
  }
  if (low.includes("unsupported url")) {
    return "This URL isn't supported. Try the desktop site URL instead of mobile/share links.";
  }
  if (low.includes("http error 403")) return "Access denied (403). The site may block automated downloads.";
  if (low.includes("http error 404")) return "URL not found (404). Check the link.";
  if (low.includes("unable to extract")) {
    return "Couldn't extract video info — the site may have changed. Try updating yt-dlp.";
  }
  if (low.includes("no spotify") || low.includes("spotipy")) {
    return "Couldn't reach Spotify metadata. Check your internet connection.";
  }
  return `Download failed (code ${exitCode}): ${detail}`;
}

/**
 * friendlyError plus the one failure only the server has: the egress proxy
 * refusing a private/local destination (its reason phrase shows up in
 * yt-dlp's error). Everything else keeps the desktop wording.
 */
export function serverFriendlyError(detail, exitCode, stderr = "") {
  // Patterns are looked for in the whole stderr when the caller has it:
  // ffmpeg's "not on whitelist" line is usually above the 3-line tail.
  const s = `${stderr}\n${detail}`;
  if (s.includes("Blocked by Convert-X egress policy")) {
    return "That link leads to a private or local network address, which the downloader won't fetch.";
  }
  // ffmpeg's protocol/format whitelists, yt-dlp's own scheme check, or a
  // protocol whose helper the image doesn't ship (rtmpdump).
  if (/not on whitelist|Unsupported url scheme|RTMP download detected/i.test(s)) {
    return "That link streams over a protocol the web downloader doesn't fetch (only http and https).";
  }
  if (/407 Proxy Authentication Required/i.test(s)) {
    return "The downloader is misconfigured: its egress proxy refused it (EGRESS_TOKEN differs between api and egress).";
  }
  if (/Unable to connect to proxy|Cannot connect to proxy|ProxyError/i.test(s)) {
    return "The downloader can't reach its egress proxy right now. Try again in a moment.";
  }
  return friendlyError(detail, exitCode);
}

// ── staging outputs ─────────────────────────────────────────────────────────

const VIDEO_EXTS = ["mp4", "mkv", "webm", "avi", "mov"];
const AUDIO_EXTS = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aac"];
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "heic"];

export function expectedExts(format) {
  if (isAudioFormat(format)) return AUDIO_EXTS;
  if (isVideoFormat(format)) return VIDEO_EXTS;
  if (format === "image") return IMAGE_EXTS;
  return VIDEO_EXTS;
}

/** Port of collect_staging_files: final media files, yt-dlp temp artifacts skipped. */
export function collectStagingFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of names) {
    if (!d.isFile()) continue;
    const name = d.name.toLowerCase();
    if (name.endsWith(".part") || name.endsWith(".ytdl") || name.endsWith(".tmp") || name.includes(".part-frag")) {
      continue;
    }
    out.push(path.join(dir, d.name));
  }
  return out;
}

/**
 * The primary-output pick of move_staging_outputs: largest file with an
 * extension the requested format expects, else the largest file overall.
 * `files` = [{path, size}]. Ties keep the LAST max (Rust's max_by_key).
 */
export function pickPrimaryOutput(files, format) {
  if (!files.length) return null;
  const exts = expectedExts(format);
  const extOf = (p) => {
    const e = path.extname(p).slice(1);
    return e ? e.toLowerCase() : null;
  };
  const maxBy = (list) => list.reduce((best, f) => (best === null || f.size >= best.size ? f : best), null);
  const matching = files.filter((f) => {
    const e = extOf(f.path);
    return e !== null && exts.includes(e);
  });
  return maxBy(matching) || maxBy(files);
}

/** Port of title_from_path: the file stem. */
export function titleFromPath(p) {
  const base = path.basename(String(p));
  const ext = path.extname(base);
  const stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
  return stem || "download";
}

// ── probe JSON → ProbeResult ────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const jsonStr = (v, key) => (isObj(v) && typeof v[key] === "string" ? v[key] : null);
const jsonF64 = (v, key) => (isObj(v) && typeof v[key] === "number" && Number.isFinite(v[key]) ? v[key] : null);

function pickThumbnail(v) {
  const s = jsonStr(v, "thumbnail");
  if (s !== null) return s;
  const arr = isObj(v) && Array.isArray(v.thumbnails) ? v.thumbnails : null;
  if (arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const u = jsonStr(arr[i], "url");
      if (u !== null) return u;
    }
  }
  return null;
}

const PROBE_IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "heic"];

/** Port of classify_entry → "audio" | "image" | "video". */
export function classifyEntry(v) {
  const vcodec = jsonStr(v, "vcodec") ?? "";
  const acodec = jsonStr(v, "acodec") ?? "";
  const ext = (jsonStr(v, "ext") ?? "").toLowerCase();
  const duration = jsonF64(v, "duration") ?? 0;

  if (vcodec.toLowerCase() === "none" && acodec !== "" && acodec.toLowerCase() !== "none") {
    return "audio";
  }
  if (PROBE_IMAGE_EXTS.includes(ext) && duration <= 0) return "image";
  if (duration <= 0 && (vcodec === "" || vcodec.toLowerCase() === "none") && acodec === "") {
    if (PROBE_IMAGE_EXTS.includes(ext)) return "image";
  }
  return "video";
}

function entryTitle(v, index) {
  return jsonStr(v, "title") ?? jsonStr(v, "id") ?? `Item ${index}`;
}

function singleFromTop(json, title, uploader, thumbnail) {
  return {
    kind: "single",
    title,
    uploader,
    thumbnail,
    entries: [
      {
        index: 1,
        title,
        thumbnail,
        duration: jsonF64(json, "duration"),
        kind: classifyEntry(json),
        url: jsonStr(json, "webpage_url") ?? jsonStr(json, "url"),
        webpage_url: jsonStr(json, "webpage_url") ?? jsonStr(json, "original_url"),
      },
    ],
  };
}

/** Port of parse_probe_json → the Rust ProbeResult (snake_case fields). */
export function parseProbeJson(json) {
  const topType = (jsonStr(json, "_type") ?? "").toLowerCase();
  const isPlaylist =
    topType === "playlist" || topType === "multi_video" || (isObj(json) && Array.isArray(json.entries));

  const title = jsonStr(json, "title") ?? "Untitled";
  const uploader = jsonStr(json, "uploader") ?? jsonStr(json, "channel") ?? jsonStr(json, "uploader_id");
  const thumbnail = pickThumbnail(json);

  if (isPlaylist) {
    const entries = [];
    const arr = isObj(json) && Array.isArray(json.entries) ? json.entries : [];
    arr.forEach((e, i) => {
      const index = i + 1;
      entries.push({
        index,
        title: entryTitle(e, index),
        thumbnail: pickThumbnail(e),
        duration: jsonF64(e, "duration"),
        kind: classifyEntry(e),
        url: jsonStr(e, "url") ?? jsonStr(e, "webpage_url"),
        // NEVER fall back to `url` — for pre-merged formats it's a signed,
        // expiring CDN media URL, not a page.
        webpage_url: jsonStr(e, "webpage_url"),
      });
    });
    if (entries.length === 0) return singleFromTop(json, title, uploader, thumbnail);
    return { kind: entries.length === 1 ? "single" : "multi", title, uploader, thumbnail, entries };
  }
  return singleFromTop(json, title, uploader, thumbnail);
}

/** "MM:SS" like the Rust progress payload. */
export function formatElapsed(ms) {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}
