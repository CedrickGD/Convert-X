import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { AUDIO_FORMATS } from "@convertx/shared/core/formats.js";
import { CAPS, isAllowedMediaHost, isCorsSafeUrl } from "@convertx/shared/core/discordMedia.js";

// ---------------------------------------------------------------------------
// Convert-X gateway (Cloudflare Worker in front of the self-hosted NAS
// downloader). Public routes (/v1/media, /v1/resolve/klipy, /v1/file) need
// no key — they power the Discord sticker stealer for everyone. The yt-dlp
// downloader (/v1/dl/*) is gated by a personal access key.
// ---------------------------------------------------------------------------

const GATEWAY_BASE = String(
  import.meta.env?.VITE_CONVERTX_GATEWAY || "https://convertx-api.rr-admin-panel.workers.dev"
).replace(/\/+$/, "");
const GATEWAY_KEY_STORAGE = "convertx.gatewayKey";
const NO_KEY_MESSAGE = "Enter an access key to use the downloader on the web.";
const SPOTIFY_WEB_MESSAGE = "Spotify downloads need the desktop app.";
const GATEWAY_CHECK_TIMEOUT_MS = 10000;
const JOB_POLL_MS = 1000;

function readStoredKey() {
  try {
    const v = localStorage.getItem(GATEWAY_KEY_STORAGE);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredKey(key) {
  try {
    if (key) localStorage.setItem(GATEWAY_KEY_STORAGE, key);
    else localStorage.removeItem(GATEWAY_KEY_STORAGE);
  } catch {
    // Private mode / disabled storage — the in-memory copy still works for
    // this session.
  }
}

function isAbortError(e) {
  return e?.name === "AbortError" || e?.cancelled === true;
}

function cancelledError() {
  const e = new Error("Cancelled");
  e.name = "AbortError";
  e.cancelled = true;
  return e;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "that site";
  }
}

function isSpotifyRef(url) {
  return /open\.spotify\.com|^spotify:/i.test(String(url || ""));
}

const EXT_MIME = {
  gif: "image/gif",
  png: "image/png",
  apng: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  json: "application/json",
};

function mimeForName(name) {
  return EXT_MIME[getExt(String(name || ""))] || "application/octet-stream";
}

/** Friendly copy for a refused media fetch; the status rides on .httpStatus. */
function mediaHttpError(status) {
  let message;
  if (status === 404 || status === 410) message = `That file is no longer available (HTTP ${status}).`;
  else if (status === 401 || status === 403) message = `The server refused that file (HTTP ${status}).`;
  else if (status === 413) message = "That file is too big to fetch here.";
  else if (status === 429) message = "The media server is rate-limiting us — wait a moment and try again.";
  else if (status >= 500) message = `The media server had a problem (HTTP ${status}) — try again.`;
  else message = `Download failed (HTTP ${status}).`;
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

/** Read a response body, stopping (and cancelling the stream) at maxBytes. */
async function readBodyCapped(res, maxBytes) {
  if (!res.body) return new Uint8Array(0);
  const cap = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : Infinity;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = cap - total;
      if (value.length >= room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        total += Math.max(0, room);
        try { await reader.cancel(); } catch (_) {}
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function formatClock(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(cancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Hand a URL to the browser's own download manager (the gateway answers
 *  with Content-Disposition: attachment, so the page never navigates). */
function triggerBrowserDownload(href, fileName) {
  const a = document.createElement("a");
  a.href = href;
  if (fileName) a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Magic bytes detection (ported from Rust detect.rs)
function detectByMagicBytes(data) {
  if (data.length < 12) return null;

  // Image formats
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47)
    return { type: "image", mime: "image/png" };
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF)
    return { type: "image", mime: "image/jpeg" };
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38)
    return { type: "image", mime: "image/gif" };
  if (data[0] === 0x42 && data[1] === 0x4D)
    return { type: "image", mime: "image/bmp" };
  if ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2A && data[3] === 0x00) ||
      (data[0] === 0x4D && data[1] === 0x4D && data[2] === 0x00 && data[3] === 0x2A))
    return { type: "image", mime: "image/tiff" };
  if (data[0] === 0x00 && data[1] === 0x00 && data[2] === 0x01 && data[3] === 0x00)
    return { type: "image", mime: "image/x-icon" };
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50)
    return { type: "image", mime: "image/webp" };

  // Audio formats
  if (data[0] === 0x66 && data[1] === 0x4C && data[2] === 0x61 && data[3] === 0x43)
    return { type: "audio", mime: "audio/flac" };
  if (data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53)
    return { type: "audio", mime: "audio/ogg" };
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33)
    return { type: "audio", mime: "audio/mpeg" };
  if (data[0] === 0xFF && (data[1] & 0xE0) === 0xE0)
    return { type: "audio", mime: "audio/mpeg" };
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45)
    return { type: "audio", mime: "audio/wav" };

  // ASF (WMV/WMA)
  if (data[0] === 0x30 && data[1] === 0x26 && data[2] === 0xB2 && data[3] === 0x75)
    return { type: "video", mime: "video/x-ms-asf" };

  // Video formats
  if (data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3)
    return { type: "video", mime: "video/x-matroska" };
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x41 && data[9] === 0x56 && data[10] === 0x49 && data[11] === 0x20)
    return { type: "video", mime: "video/x-msvideo" };
  if (data[0] === 0x46 && data[1] === 0x4C && data[2] === 0x56)
    return { type: "video", mime: "video/x-flv" };
  if (data.length >= 8 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70)
    return { type: "video", mime: "video/mp4" };

  return null;
}

function detectByExtension(ext) {
  const map = {
    png: { type: "image", mime: "image/png" },
    jpg: { type: "image", mime: "image/jpeg" },
    jpeg: { type: "image", mime: "image/jpeg" },
    gif: { type: "image", mime: "image/gif" },
    bmp: { type: "image", mime: "image/bmp" },
    tiff: { type: "image", mime: "image/tiff" },
    tif: { type: "image", mime: "image/tiff" },
    ico: { type: "image", mime: "image/x-icon" },
    webp: { type: "image", mime: "image/webp" },
    mp4: { type: "video", mime: "video/mp4" },
    m4v: { type: "video", mime: "video/mp4" },
    mkv: { type: "video", mime: "video/x-matroska" },
    avi: { type: "video", mime: "video/x-msvideo" },
    webm: { type: "video", mime: "video/webm" },
    mov: { type: "video", mime: "video/quicktime" },
    flv: { type: "video", mime: "video/x-flv" },
    wmv: { type: "video", mime: "video/x-ms-wmv" },
    ts: { type: "video", mime: "video/mp2t" },
    mp3: { type: "audio", mime: "audio/mpeg" },
    wav: { type: "audio", mime: "audio/wav" },
    flac: { type: "audio", mime: "audio/flac" },
    ogg: { type: "audio", mime: "audio/ogg" },
    aac: { type: "audio", mime: "audio/aac" },
    wma: { type: "audio", mime: "audio/x-ms-wma" },
    m4a: { type: "audio", mime: "audio/mp4" },
    opus: { type: "audio", mime: "audio/opus" },
  };
  return map[ext] || null;
}

function getImageDimensions(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function getVideoDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve(isFinite(video.duration) ? video.duration : null);
      URL.revokeObjectURL(url);
    };
    video.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    video.src = url;
  });
}

function getAudioDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      resolve(isFinite(audio.duration) ? audio.duration : null);
      URL.revokeObjectURL(url);
    };
    audio.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    audio.src = url;
  });
}

function formatElapsed(timeUs) {
  if (!timeUs) return "00:00";
  const sec = Math.floor(timeUs / 1000000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getExt(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.substring(dot + 1).toLowerCase() : "";
}

function clampQuality(quality) {
  return Math.max(1, Math.min(100, quality || 75));
}

function getGifColorCap(quality) {
  const q = clampQuality(quality);
  return Math.round(32 + ((q - 1) * 224 / 99));
}

function getGifPaletteStrategy(quality) {
  const q = clampQuality(quality);
  if (q >= 90) {
    return { statsMode: "single", usePerFramePalette: true };
  }
  if (q >= 60) {
    return { statsMode: "full", usePerFramePalette: false };
  }
  return { statsMode: "diff", usePerFramePalette: false };
}

function clampEven(value, min) {
  const safe = Math.max(min, value || min);
  return safe % 2 === 0 ? safe : Math.max(min, safe - 1);
}

function lowerPalette(current, suggestedMax) {
  const stops = [256, 224, 192, 160, 128, 96, 64, 48, 32, 24, 16, 8];
  const cap = Math.max(8, Math.min(256, suggestedMax || current));

  for (const stop of stops) {
    if (stop < current && stop <= cap) return stop;
  }
  for (const stop of stops) {
    if (stop < current) return stop;
  }
  return current;
}

function nextGifAttempt(current, targetRatio, allowFpsReduction, minWidth) {
  const ratio = Math.max(0.2, Math.min(0.96, targetRatio));
  const next = { ...current };

  if (current.width) {
    const scaled = clampEven(Math.round(current.width * Math.sqrt(ratio * 0.92)), minWidth);
    if (scaled < current.width) next.width = scaled;
  }

  if (allowFpsReduction && current.fps) {
    const scaled = Math.max(5, Math.min(current.fps, Math.round(current.fps * Math.pow(ratio, 0.35))));
    if (scaled < current.fps) next.fps = scaled;
  }

  const suggestedColors = Math.max(8, Math.min(256, Math.round(current.colors * Math.pow(ratio, 0.55))));
  const nextColors = lowerPalette(current.colors, suggestedColors);
  if (nextColors < current.colors) next.colors = nextColors;

  const nextQuality = Math.max(20, Math.min(100, Math.round(current.quality * Math.pow(ratio, 0.25))));
  if (nextQuality < current.quality) next.quality = nextQuality;

  if (
    next.width === current.width &&
    next.fps === current.fps &&
    next.colors === current.colors &&
    next.quality === current.quality
  ) {
    if (current.width) {
      const forcedWidth = clampEven(current.width - 64, minWidth);
      if (forcedWidth < current.width) next.width = forcedWidth;
    }

    if (allowFpsReduction && current.fps) {
      const forcedFps = Math.max(5, current.fps - (current.fps > 15 ? 5 : 2));
      if (forcedFps < current.fps) next.fps = forcedFps;
    }

    const forcedColors = lowerPalette(current.colors, current.colors - 32);
    if (forcedColors < current.colors) next.colors = forcedColors;

    if (next.quality === current.quality) {
      next.quality = Math.max(20, current.quality - 10);
    }
  }

  if (
    next.width === current.width &&
    next.fps === current.fps &&
    next.colors === current.colors &&
    next.quality === current.quality
  ) {
    return null;
  }

  return next;
}

function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function createGifAttempt(params) {
  let width = params.gifWidth || null;

  if (!width && params.resolution) {
    const parsed = parseInt(params.resolution.split("x")[0], 10);
    width = Number.isFinite(parsed) ? parsed : null;
  }

  if (!width && params.fileType === "image" && params.fileObj) {
    const dims = await getImageDimensions(params.fileObj);
    width = dims?.width || null;
  }

  return {
    width,
    fps: params.fileType === "video" ? (params.gifFps || params.fps || 15) : null,
    colors: Math.max(8, Math.min(256, params.gifColors || 256)),
    quality: clampQuality(params.quality),
  };
}

function splitAtempo(speed) {
  // ffmpeg's atempo accepts factors in [0.5, 2.0]; chain them to reach others.
  const out = [];
  let s = Math.max(0.1, Math.min(10, speed || 1));
  if (Math.abs(s - 1) < 1e-6) return out;
  while (s > 2.0) { out.push(2.0); s /= 2.0; }
  while (s < 0.5) { out.push(0.5); s /= 0.5; }
  out.push(Number(s.toFixed(4)));
  return out;
}

function buildEditFilters(params) {
  // Returns array of filters in order: crop, rotate, flips, then caller-appended.
  const filters = [];
  if (params.crop && params.crop.w > 0 && params.crop.h > 0) {
    const c = params.crop;
    filters.push(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);
  }
  const rot = ((params.rotate || 0) % 360 + 360) % 360;
  if (rot === 90) filters.push("transpose=1");
  else if (rot === 180) filters.push("transpose=1", "transpose=1");
  else if (rot === 270) filters.push("transpose=2");
  if (params.flipH) filters.push("hflip");
  if (params.flipV) filters.push("vflip");
  return filters;
}

function volumeMultiplier(params) {
  const v = Number(params.volume);
  if (!Number.isFinite(v)) return null;
  const clamped = Math.max(0, Math.min(8, v));
  return Math.abs(clamped - 1) < 1e-6 ? null : clamped;
}

function buildAudioFilterChain(params) {
  if (params.stripAudio) return null;
  const parts = [];
  const speed = Number(params.speed) || 1;
  if (Math.abs(speed - 1) > 1e-6) {
    for (const f of splitAtempo(speed)) parts.push(`atempo=${f}`);
  }
  const vol = volumeMultiplier(params);
  if (vol != null) parts.push(`volume=${vol}`);
  return parts.length ? parts.join(",") : null;
}

// Quality 0-100 -> audio bitrate, mirroring the desktop ladder in
// src-tauri/src/ffmpeg.rs build_audio_args.
function audioBitrateFor(quality) {
  const q = clampQuality(quality);
  if (q <= 20) return "64k";
  if (q <= 40) return "96k";
  if (q <= 60) return "128k";
  if (q <= 80) return "192k";
  if (q <= 95) return "256k";
  return "320k";
}

function buildFFmpegArgs(inputName, outputName, params) {
  const args = ["-i", inputName];
  const isGif = params.outputFormat === "gif";
  const speed = Number(params.speed) || 1;
  const speedActive = Math.abs(speed - 1) > 1e-6;

  if (params.trimStart) args.push("-ss", String(params.trimStart));
  if (params.trimEnd) args.push("-to", String(params.trimEnd));

  if (isGif) {
    // GIF: build complete filter chain (edits + scale + fps + palette in one -vf)
    const filters = buildEditFilters(params);

    if (params.gifWidth) {
      filters.push(`scale=${params.gifWidth}:-1:flags=lanczos`);
    } else if (params.resolution) {
      const [w, h] = params.resolution.split("x");
      filters.push(`scale=${w}:${h}:flags=lanczos`);
    }

    if (params.gifFps) {
      filters.push(`fps=${params.gifFps}`);
    } else if (params.fps) {
      filters.push(`fps=${params.fps}`);
    }

    if (speedActive) {
      filters.push(`setpts=PTS/${speed}`);
    }

    const requestedColors = Math.max(2, Math.min(256, params.gifColors || 256));
    const colors = Math.min(requestedColors, getGifColorCap(params.quality));
    const dither = params.gifDither || "sierra2_4a";
    const { statsMode, usePerFramePalette } = getGifPaletteStrategy(params.quality);
    const prefix = filters.length ? filters.join(",") + "," : "";
    const paletteuse = [`dither=${dither}`];
    if (usePerFramePalette) paletteuse.push("new=1");

    args.push("-vf", `${prefix}split[s0][s1];[s0]palettegen=max_colors=${colors}:stats_mode=${statsMode}[p];[s1][p]paletteuse=${paletteuse.join(":")}`);
    args.push("-an");
    args.push("-loop", "0");
  } else if (AUDIO_FORMATS.includes(params.outputFormat)) {
    // Audio target (a video source is allowed — see core/formats.js). Without
    // -vn the muxer keeps the auto-selected video stream and re-encodes the
    // picture into the audio container. Parity with ffmpeg.rs build_audio_args
    // / android ffmpegArgs.ts buildAudioArgs: no video-only arg applies here.
    args.push("-vn");

    const audioChain = buildAudioFilterChain(params);
    if (audioChain) args.push("-af", audioChain);

    // pcm/flac ignore -b:a; every other target gets the quality ladder. The
    // Advanced bitrate field offers VIDEO rates ("2M") whenever the source is
    // a video, so it must not be reused as an audio rate — encoders like
    // libmp3lame reject it outright.
    if (params.outputFormat !== "wav" && params.outputFormat !== "flac") {
      const explicit = params.fileType === "video" ? null : params.bitrate;
      args.push("-b:a", explicit || audioBitrateFor(params.quality));
    }
  } else {
    // Non-GIF formats
    const filters = buildEditFilters(params);

    if (params.resolution) {
      const [w, h] = params.resolution.split("x");
      filters.push(`scale=${w}:${h}`);
    }

    if (speedActive) {
      filters.push(`setpts=PTS/${speed}`);
    }

    if (filters.length) {
      args.push("-vf", filters.join(","));
    }

    if (params.fps) args.push("-r", String(params.fps));
    if (params.stripAudio) {
      args.push("-an");
    } else {
      const audioChain = buildAudioFilterChain(params);
      if (audioChain) args.push("-af", audioChain);
    }
    if (params.bitrate) args.push("-b:v", params.bitrate);
    if (params.preset) args.push("-preset", params.preset);

    if (["jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(params.outputFormat)) {
      if (params.outputFormat === "jpg" || params.outputFormat === "jpeg") {
        args.push("-q:v", String(Math.max(1, Math.round(31 - (params.quality / 100) * 30))));
      } else if (params.outputFormat === "webp") {
        args.push("-quality", String(params.quality));
      }
    } else {
      const crf = Math.round(51 - (params.quality / 100) * 51);
      if (["mp4", "mkv", "webm", "avi", "mov"].includes(params.outputFormat)) {
        args.push("-crf", String(crf));
      }
    }
  }

  args.push("-y", outputName);
  return args;
}

async function encodeGifWithTargetSize(ff, inputName, outputName, params) {
  const targetMb = params.gifTargetSizeMb || null;
  if (!targetMb) return null;

  const targetBytes = targetMb * 1024 * 1024;
  const allowFpsReduction = params.fileType === "video";
  const minWidth = allowFpsReduction ? 160 : 96;
  let attempt = await createGifAttempt(params);
  let bestSize = Number.POSITIVE_INFINITY;

  for (let i = 0; i < 7; i += 1) {
    const attemptParams = {
      ...params,
      quality: attempt.quality,
      gifColors: attempt.colors,
      gifWidth: attempt.width,
      gifFps: attempt.fps,
    };

    await ff.exec(buildFFmpegArgs(inputName, outputName, attemptParams));
    const data = await ff.readFile(outputName);
    const size = data.length;
    bestSize = Math.min(bestSize, size);

    if (size <= targetBytes) {
      return data;
    }

    const next = nextGifAttempt(attempt, targetBytes / size, allowFpsReduction, minWidth);
    if (!next) break;
    attempt = next;
  }

  try { await ff.deleteFile(outputName); } catch (_) {}
  throw new Error(`Couldn't fit GIF under ${targetMb} MB. Smallest result was ${formatMegabytes(bestSize)}.`);
}

export function createWebAdapter() {
  let ffmpeg = null;
  let ffmpegLoading = null;
  let progressCallbacks = [];
  let downloadProgressCallbacks = [];
  let currentFileId = "";

  // Convert/Resize lane core. The sticker batch runs on its OWN core
  // (ensureStickerFFmpeg) so each lane's cancel — which terminates the
  // worker — can never abort the other lane's in-flight work.
  async function ensureFFmpeg() {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;
    // A load already in flight (two Convert/Resize calls racing) is shared
    // instead of spawning a second core.
    if (ffmpegLoading && ffmpeg) return ffmpegLoading;
    const ff = new FFmpeg();
    ffmpeg = ff;
    ff.on("progress", ({ progress, time }) => {
      progressCallbacks.forEach((cb) =>
        cb({
          file_id: currentFileId,
          progress: Math.min(100, Math.round(progress * 100)),
          elapsed: formatElapsed(time),
        })
      );
    });
    const loading = ff.load().then(() => ff);
    ffmpegLoading = loading;
    try {
      return await loading;
    } finally {
      if (ffmpegLoading === loading) ffmpegLoading = null;
    }
  }

  // ── Gateway key ──────────────────────────────────────────────────────────
  let gatewayKey = readStoredKey();

  function getKey() {
    return gatewayKey;
  }

  function setKey(key) {
    const k = typeof key === "string" && key.trim() ? key.trim() : null;
    gatewayKey = k;
    writeStoredKey(k);
  }

  // ── Per-fileId cancellation bookkeeping ──────────────────────────────────
  const aborts = new Map(); // fileId -> Set<AbortController>
  const nasJobs = new Map(); // fileId -> NAS jobId

  function trackAbort(fileId) {
    const ctrl = new AbortController();
    const key = fileId ?? "";
    if (!aborts.has(key)) aborts.set(key, new Set());
    aborts.get(key).add(ctrl);
    return ctrl;
  }

  function untrackAbort(fileId, ctrl) {
    const key = fileId ?? "";
    const set = aborts.get(key);
    if (!set) return;
    set.delete(ctrl);
    if (set.size === 0) aborts.delete(key);
  }

  function emitDownloadProgress(payload) {
    downloadProgressCallbacks.forEach((cb) => {
      try {
        cb(payload);
      } catch (_) {
        // A broken listener must not break the transfer.
      }
    });
  }

  // ── Media routing (Discord stealer, thumbnails) ──────────────────────────
  // CORS-safe CDNs are fetched straight from the browser; everything else
  // on the relay allowlist goes through the public /v1/media proxy (status
  // passthrough). A CORS-safe host can still omit CORS headers on its error
  // responses (cdn.discordapp.com/emojis 404s), so a network-level failure
  // there retries through the relay to learn the real status.
  function mediaProxyUrl(url) {
    return `${GATEWAY_BASE}/v1/media?url=${encodeURIComponent(url)}`;
  }

  function relayUnreachable(cause) {
    const e = new Error(
      "Couldn't reach the Convert-X relay this link needs — check your connection and try again in a bit."
    );
    e.cause = cause;
    return e;
  }

  function directUnreachable(url, cause) {
    const e = new Error(`Couldn't load media from ${hostOf(url)} — check your connection and try again.`);
    e.cause = cause;
    return e;
  }

  async function mediaFetch(url, init = {}) {
    const direct = isCorsSafeUrl(url);
    const relayed = isAllowedMediaHost(url);
    if (direct || !relayed) {
      try {
        const res = await fetch(url, init);
        return { res, finalUrl: res.url || url };
      } catch (e) {
        if (isAbortError(e)) throw e;
        if (!relayed) throw directUnreachable(url, e);
      }
    }
    try {
      const res = await fetch(mediaProxyUrl(url), init);
      return { res, finalUrl: res.headers.get("x-final-url") || url };
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw relayUnreachable(e);
    }
  }

  const discordNet = {
    async getBytes(url, { maxBytes, headers } = {}) {
      const { res, finalUrl } = await mediaFetch(url, headers ? { headers } : {});
      const bytes = await readBodyCapped(res, maxBytes);
      return { status: res.status, contentType: res.headers.get("content-type"), bytes, finalUrl };
    },
    async getText(url, { headers } = {}) {
      const { res, finalUrl } = await mediaFetch(url, headers ? { headers } : {});
      const bytes = await readBodyCapped(res, 16 * 1024 * 1024);
      return {
        status: res.status,
        contentType: res.headers.get("content-type"),
        text: new TextDecoder().decode(bytes),
        finalUrl,
      };
    },
    async head(url) {
      const { res } = await mediaFetch(url, { method: "HEAD" });
      return { status: res.status, contentType: res.headers.get("content-type") };
    },
    async klipyResolve(type, slug) {
      // The resolver turns any non-200 into its own friendly copy, so a
      // relay outage resolves (status 0) instead of rejecting.
      try {
        const res = await fetch(
          `${GATEWAY_BASE}/v1/resolve/klipy?type=${encodeURIComponent(type)}&slug=${encodeURIComponent(slug)}`
        );
        let json = null;
        try {
          json = await res.json();
        } catch (_) {}
        return { status: res.status, json };
      } catch (_) {
        return { status: 0, json: null };
      }
    },
  };

  // ── Sticker transcodes on ffmpeg.wasm ────────────────────────────────────
  // One exec at a time (promise chain). The staged input is reused across a
  // size ladder's attempts for the same fileId. Cancel = terminate the core
  // (it reloads on next use) for the running job, a flag for queued ones.
  //
  // This lane has its OWN core: terminate() rejects every in-flight call on
  // a worker, so sharing the Convert tab's core let cancelConversion abort a
  // background sticker batch (and a sticker cancel abort a conversion).
  let stickerFF = null;
  let stickerFFLoading = null;

  async function ensureStickerFFmpeg() {
    if (stickerFF && stickerFF.loaded) return stickerFF;
    if (stickerFFLoading && stickerFF) return stickerFFLoading;
    const ff = new FFmpeg();
    stickerFF = ff;
    const loading = ff.load().then(() => ff);
    stickerFFLoading = loading;
    try {
      return await loading;
    } finally {
      if (stickerFFLoading === loading) stickerFFLoading = null;
    }
  }

  let transcodeChain = Promise.resolve();
  let transcodeEpoch = 0;
  const cancelledTranscodes = new Set();
  const stagedInputs = new Map(); // fileId -> { ff, handle, name }
  let activeTranscode = null; // { fileId }
  let stickerSeq = 0;

  function transcodeCancelled(fileId, epoch) {
    return epoch !== transcodeEpoch || cancelledTranscodes.has(fileId);
  }

  function cancelTranscodes(fileId) {
    if (fileId == null) transcodeEpoch += 1;
    else cancelledTranscodes.add(fileId);
    if (activeTranscode && (fileId == null || activeTranscode.fileId === fileId) && stickerFF) {
      try {
        stickerFF.terminate();
      } catch (_) {}
      stickerFF = null;
      stickerFFLoading = null;
      stagedInputs.clear();
    }
  }

  async function stageInput(ff, fileId, input) {
    const cur = stagedInputs.get(fileId);
    if (cur && cur.ff === ff && cur.handle === input) return cur.name;
    if (cur && cur.ff === ff) {
      try { await ff.deleteFile(cur.name); } catch (_) {}
    }
    stickerSeq += 1;
    const name = `stk-${stickerSeq}-in.${getExt(input.name || "") || "bin"}`;
    // writeFile transfers the buffer — always hand it a fresh copy.
    await ff.writeFile(name, new Uint8Array(await input.blob.arrayBuffer()));
    stagedInputs.set(fileId, { ff, handle: input, name });
    return name;
  }

  async function runTranscode({ fileId, input, inputArgs, outputArgs, outputExt, epoch }) {
    const cancelled = { handle: null, size: 0, cancelled: true };
    if (transcodeCancelled(fileId, epoch)) return cancelled;
    const ext = String(outputExt || "").toLowerCase();
    if (!/^(gif|png|webp|mp4|jpg)$/.test(ext)) throw new Error(`Unsupported output type: ${outputExt}`);
    if (!input?.blob) throw new Error("Nothing to convert.");

    const ff = await ensureStickerFFmpeg();
    if (transcodeCancelled(fileId, epoch)) return cancelled;

    stickerSeq += 1;
    const outName = `stk-${stickerSeq}-out.${ext}`;
    const logs = [];
    const onLog = ({ message }) => {
      if (!message) return;
      logs.push(message);
      if (logs.length > 30) logs.shift();
    };
    // No currentFileId juggling: the sticker core has no "progress" listener
    // (that's the Convert lane's core), so it never emits onProgress events.
    activeTranscode = { fileId };
    ff.on("log", onLog);
    try {
      const inName = await stageInput(ff, fileId, input);
      const ret = await ff.exec([
        "-y", "-hide_banner", "-loglevel", "error",
        ...inputArgs, "-i", inName, ...outputArgs, outName,
      ]);
      if (transcodeCancelled(fileId, epoch)) return cancelled;
      if (ret !== 0) {
        const tail = logs.join(" ").replace(/\s+/g, " ").trim().slice(-300);
        throw new Error(tail ? `Conversion failed: ${tail}` : `Conversion failed (FFmpeg exit ${ret}).`);
      }
      const data = await ff.readFile(outName);
      if (!data || data.length === 0) throw new Error("Conversion produced an empty file.");
      const blob = new Blob([data], { type: EXT_MIME[ext] || "application/octet-stream" });
      return { handle: { blob, size: blob.size, name: `output.${ext}` }, size: blob.size };
    } catch (e) {
      if (transcodeCancelled(fileId, epoch)) return cancelled;
      throw e;
    } finally {
      try { ff.off("log", onLog); } catch (_) {}
      if (stickerFF === ff) {
        try { await ff.deleteFile(outName); } catch (_) {}
      }
      activeTranscode = null;
    }
  }

  // ── Keyed downloader (/v1/dl/* on the NAS) ───────────────────────────────
  function dlError(status, json) {
    const msg = json && typeof json.error === "string" && json.error.trim() ? json.error.trim() : null;
    if (status === 401 || status === 403) {
      return new Error("Your access key was rejected — check it in the Access key card.");
    }
    if (status === 503) return new Error("The downloader is offline right now — try again later.");
    if (status === 429) return new Error(msg || "Too many downloads for now — try again later.");
    return new Error(msg || `The downloader hit a problem (HTTP ${status}).`);
  }

  async function dlFetch(path, init = {}) {
    const key = getKey();
    if (!key) throw new Error(NO_KEY_MESSAGE);
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${key}`);
    try {
      return await fetch(`${GATEWAY_BASE}/v1/dl${path}`, { ...init, headers });
    } catch (e) {
      if (isAbortError(e)) throw e;
      const err = new Error("Couldn't reach the Convert-X downloader — check your connection and try again.");
      err.cause = e;
      throw err;
    }
  }

  async function dlJson(path, { method = "GET", body, signal } = {}) {
    const init = { method, signal };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    const res = await dlFetch(path, init);
    let json = null;
    try {
      json = await res.json();
    } catch (_) {}
    if (!res.ok) throw dlError(res.status, json);
    if (json === null) throw new Error("The downloader sent an unexpected reply.");
    return json;
  }

  /** Stream a body into a Blob, reporting download-progress for fileId. */
  async function readBlobWithProgress(res, fileId, type) {
    const total = parseInt(res.headers.get("content-length") || "", 10);
    const started = Date.now();
    if (!res.body) return new Blob([], { type });
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    let lastEmit = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      const now = Date.now();
      if (now - lastEmit > 200) {
        lastEmit = now;
        emitDownloadProgress({
          file_id: fileId,
          progress: Number.isFinite(total) && total > 0 ? Math.min(100, (got / total) * 100) : -1,
          elapsed: formatClock(now - started),
          stage: "downloading",
        });
      }
    }
    return new Blob(chunks, { type });
  }

  return {
    platformType: "web",

    // Discord sticker stealer + gateway.
    stickerCaps: CAPS.web,
    discordNet,
    gateway: {
      base: GATEWAY_BASE,
      getKey,
      setKey,
      /** -> 'ok' | 'invalid' | 'offline' | 'nokey' */
      async check() {
        const key = getKey();
        if (!key) return "nokey";
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), GATEWAY_CHECK_TIMEOUT_MS);
        try {
          const res = await fetch(`${GATEWAY_BASE}/v1/dl/health`, {
            headers: { Authorization: `Bearer ${key}` },
            cache: "no-store",
            signal: ctrl.signal,
          });
          if (res.status === 401 || res.status === 403) return "invalid";
          if (!res.ok) return "offline";
          let json = null;
          try {
            json = await res.json();
          } catch (_) {}
          return json && json.ok === true ? "ok" : "offline";
        } catch (_) {
          return "offline";
        } finally {
          clearTimeout(timer);
        }
      },
    },
    capabilities: {
      // Re-evaluated on every read: the downloader unlocks with a key.
      get urlDownloads() {
        return !!getKey();
      },
    },

    async fetchMedia({ fileId, url, fileName }) {
      const ctrl = trackAbort(fileId);
      try {
        const { res } = await mediaFetch(url, { signal: ctrl.signal });
        if (!res.ok) throw mediaHttpError(res.status);
        const raw = await res.blob();
        if (raw.size === 0) throw new Error("That file came back empty.");
        const blob = raw.type ? raw : new Blob([raw], { type: mimeForName(fileName) });
        return { blob, size: blob.size, name: fileName };
      } catch (e) {
        if (isAbortError(e) || ctrl.signal.aborted) throw cancelledError();
        throw e;
      } finally {
        untrackAbort(fileId, ctrl);
      }
    },

    async importMediaBytes({ bytes, fileName }) {
      const blob = new Blob([bytes], { type: mimeForName(fileName) });
      return { blob, size: blob.size, name: fileName };
    },

    transcodeMedia({ fileId, input, inputArgs = [], outputArgs = [], outputExt }) {
      const epoch = transcodeEpoch;
      const run = transcodeChain.then(() =>
        runTranscode({ fileId, input, inputArgs, outputArgs, outputExt, epoch })
      );
      transcodeChain = run.catch(() => {});
      return run;
    },

    // Web never auto-saves: the UI decides (Save / Save all / single auto-save).
    async finalizeMedia({ handle, fileName }) {
      if (!handle?.blob) throw new Error("Nothing to save.");
      const outputBlob =
        handle.blob.type === mimeForName(fileName)
          ? handle.blob
          : new Blob([handle.blob], { type: mimeForName(fileName) });
      return { outputPath: fileName, outputSize: outputBlob.size, outputBlob };
    },

    async discardMedia(fileId) {
      cancelledTranscodes.delete(fileId);
      const staged = stagedInputs.get(fileId);
      if (!staged) return;
      stagedInputs.delete(fileId);
      if (staged.ff === stickerFF && stickerFF?.loaded) {
        try { await staged.ff.deleteFile(staged.name); } catch (_) {}
      }
    },

    async pickFiles({ multiple, extensions }) {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.multiple = multiple;
        if (extensions?.length) {
          input.accept = extensions.map((e) => `.${e}`).join(",");
        }
        input.onchange = () => {
          const files = Array.from(input.files || []);
          resolve(files.map((f) => ({ name: f.name, path: f.name, fileObj: f })));
        };
        // Handle cancel
        input.addEventListener("cancel", () => resolve([]));
        input.click();
      });
    },

    async pickFolder() {
      return null; // not supported on web
    },

    async detectFile(file) {
      const buffer = await file.slice(0, 64).arrayBuffer();
      const header = new Uint8Array(buffer);
      const ext = getExt(file.name);

      let detected = detectByMagicBytes(header) || detectByExtension(ext);
      if (!detected) throw new Error("Unsupported file format");

      const meta = {
        file_type: detected.type,
        mime_type: detected.mime,
        codec: null,
        resolution: null,
        duration: null,
        bitrate: null,
        frame_rate: null,
        size: file.size,
        file_name: file.name,
      };

      if (detected.type === "image") {
        const dims = await getImageDimensions(file);
        if (dims) meta.resolution = `${dims.width}x${dims.height}`;
      } else if (detected.type === "video") {
        const dur = await getVideoDuration(file);
        if (dur) meta.duration = dur;
      } else if (detected.type === "audio") {
        const dur = await getAudioDuration(file);
        if (dur) meta.duration = dur;
      }

      return meta;
    },

    async readFileBinary(fileOrPath) {
      if (fileOrPath instanceof File) {
        return new Uint8Array(await fileOrPath.arrayBuffer());
      }
      throw new Error("Cannot read file by path on web");
    },

    async convertFile(params) {
      const ff = await ensureFFmpeg();
      currentFileId = params.fileId;
      // params.targetSizeMb (video target-size export) is accepted but
      // ignored here — the wasm arg builder has no size-targeting math, and
      // the UI field is desktop-gated.

      const file = params.fileObj;
      const inputExt = getExt(file.name);
      const inputName = `input.${inputExt}`;
      const outName = (params.outputName || "output") + "." + params.outputFormat;

      await ff.writeFile(inputName, await fetchFile(file));
      let data;
      if (params.outputFormat === "gif" && params.gifTargetSizeMb) {
        data = await encodeGifWithTargetSize(ff, inputName, outName, params);
      } else {
        await ff.exec(buildFFmpegArgs(inputName, outName, params));
        data = await ff.readFile(outName);
      }

      // Cleanup
      try { await ff.deleteFile(inputName); } catch (_) {}
      try { await ff.deleteFile(outName); } catch (_) {}

      const blob = new Blob([data.buffer], { type: `application/octet-stream` });
      return {
        output_path: outName,
        output_size: data.length,
        outputName: outName,
        outputSize: data.length,
        outputBlob: blob,
      };
    },

    async resizeImage(params) {
      const ff = await ensureFFmpeg();
      currentFileId = params.fileId;

      const file = params.fileObj;
      const inputExt = getExt(file.name);
      const inputName = `input.${inputExt}`;
      const fmt = params.outputFormat || inputExt;
      const outName = (params.outputName || "output") + "." + fmt;

      await ff.writeFile(inputName, await fetchFile(file));

      const args = ["-i", inputName];

      // Calculate dimensions
      if (params.resizeMode === "percentage" && params.percentage) {
        const scale = params.percentage / 100;
        args.push("-vf", `scale=iw*${scale}:ih*${scale}`);
      } else if (params.width || params.height) {
        const w = params.width || -1;
        const h = params.height || -1;
        if (params.keepAspect) {
          args.push("-vf", `scale=${w}:${h}:force_original_aspect_ratio=decrease`);
        } else {
          args.push("-vf", `scale=${w}:${h}`);
        }
      }

      if (fmt === "jpg" || fmt === "jpeg") {
        args.push("-q:v", String(Math.max(1, Math.round(31 - (params.quality / 100) * 30))));
      } else if (fmt === "webp") {
        args.push("-quality", String(params.quality));
      }

      args.push("-y", outName);
      await ff.exec(args);
      const data = await ff.readFile(outName);

      try { await ff.deleteFile(inputName); } catch (_) {}
      try { await ff.deleteFile(outName); } catch (_) {}

      const blob = new Blob([data.buffer], { type: "application/octet-stream" });
      return {
        output_path: outName,
        output_size: data.length,
        outputName: outName,
        outputSize: data.length,
        outputBlob: blob,
      };
    },

    // Terminates only the Convert/Resize core — a running sticker batch
    // lives on stickerFF and keeps going.
    async cancelConversion() {
      if (ffmpeg) {
        ffmpeg.terminate();
        ffmpeg = null;
      }
    },

    // ── URL downloader: the NAS behind the gateway, only with an access key.
    // Without one every method throws NO_KEY_MESSAGE and
    // capabilities.urlDownloads is false (the UI keeps these gated).

    // -> { status: 'done', outputPath, outputSize, title, fileUrl } | { status: 'cancelled' }
    async downloadFromUrl(params) {
      if (isSpotifyRef(params?.url)) throw new Error(SPOTIFY_WEB_MESSAGE);
      if (!getKey()) throw new Error(NO_KEY_MESSAGE);
      const fileId = params.fileId;
      const ctrl = trackAbort(fileId);
      const started = Date.now();
      let jobId = null;
      try {
        const job = await dlJson("/jobs", {
          method: "POST",
          body: {
            url: params.url,
            format: params.format,
            quality: params.quality || "best",
            playlistItems: params.playlistItems || null,
            noPlaylist: params.noPlaylist ?? false,
            dedupeNames: !!params.dedupeNames,
          },
          signal: ctrl.signal,
        });
        jobId = job?.jobId;
        const token = job?.token;
        if (!jobId || !token) throw new Error("The downloader sent an unexpected reply.");
        nasJobs.set(fileId, jobId);
        emitDownloadProgress({ file_id: fileId, progress: -1, elapsed: "00:00", stage: "queued" });

        let misses = 0;
        for (;;) {
          await abortableSleep(JOB_POLL_MS, ctrl.signal);
          let st;
          try {
            st = await dlJson(`/jobs/${encodeURIComponent(jobId)}`, { signal: ctrl.signal });
            misses = 0;
          } catch (e) {
            if (isAbortError(e) || ctrl.signal.aborted) throw cancelledError();
            // Ride out a few blips (Wi-Fi hiccup, tunnel reconnect) before
            // giving up on a job that is still running server-side.
            misses += 1;
            if (misses >= 5) throw e;
            continue;
          }
          const elapsed =
            typeof st.elapsed === "string" && st.elapsed
              ? st.elapsed
              : typeof st.elapsed === "number"
                ? formatClock(st.elapsed * 1000)
                : formatClock(Date.now() - started);
          emitDownloadProgress({
            file_id: fileId,
            progress: typeof st.progress === "number" ? st.progress : -1,
            elapsed,
            stage: st.stage || st.state || "downloading",
          });
          if (st.state === "done") {
            const fileUrl = `${GATEWAY_BASE}/v1/file/${encodeURIComponent(jobId)}?t=${encodeURIComponent(token)}`;
            const fileName = st.fileName || "download";
            triggerBrowserDownload(fileUrl, fileName);
            return {
              status: "done",
              outputPath: fileName,
              outputSize: typeof st.size === "number" ? st.size : null,
              title: st.title || null,
              fileUrl,
            };
          }
          if (st.state === "cancelled") return { status: "cancelled" };
          if (st.state === "error") throw new Error(st.error || "The download failed.");
        }
      } catch (e) {
        if (isAbortError(e) || ctrl.signal.aborted) return { status: "cancelled" };
        throw e;
      } finally {
        nasJobs.delete(fileId);
        untrackAbort(fileId, ctrl);
      }
    },

    // -> the desktop ProbeResult shape (snake_case), produced by the NAS.
    async probeUrl(url) {
      if (isSpotifyRef(url)) throw new Error(SPOTIFY_WEB_MESSAGE);
      return dlJson("/probe", { method: "POST", body: { url } });
    },

    // Generic HTTP for the shared JS probers, run server-side (browsers
    // forbid the User-Agent/Cookie/Referer headers they need). Resolves on
    // any upstream HTTP status, like the desktop command.
    async httpRequest({ url, method = "GET", headers = {}, body = null, timeoutMs = 15000 }) {
      const json = await dlJson("/http", {
        method: "POST",
        body: { url, method, headers, body, timeoutMs },
      });
      if (typeof json.status !== "number") throw new Error("The downloader sent an unexpected reply.");
      return {
        status: json.status,
        body: typeof json.body === "string" ? json.body : "",
        headers: json.headers && typeof json.headers === "object" ? json.headers : {},
      };
    },

    // -> { status: 'done', outputPath, outputBlob, outputSize }
    //  | { status: 'cancelled' } | { status: 'http_error', httpStatus }
    async downloadDirect({ fileId, url, fileName }) {
      if (!getKey()) throw new Error(NO_KEY_MESSAGE);
      const ctrl = trackAbort(fileId);
      try {
        const q = `?url=${encodeURIComponent(url)}&name=${encodeURIComponent(fileName || "")}`;
        const res = await dlFetch(`/direct${q}`, { signal: ctrl.signal });
        if (!res.ok) {
          // The gateway's own refusals (bad key, NAS offline) are JSON
          // {error} WITHOUT X-Upstream-Status. A response carrying that header
          // is the CDN's status passed through (an expired signed URL can
          // answer 401), which the shared queue re-probes — so it must come
          // back as http_error, never as an "access key rejected" message.
          // (readable cross-origin: the gateway lists it in Expose-Headers.)
          const ct = res.headers.get("content-type") || "";
          const upstream = res.headers.has("x-upstream-status");
          if ((res.status === 401 || res.status === 503) && ct.includes("json") && !upstream) {
            let json = null;
            try {
              json = await res.json();
            } catch (_) {}
            if (json?.error) throw dlError(res.status, json);
          }
          return { status: "http_error", httpStatus: res.status };
        }
        const blob = await readBlobWithProgress(res, fileId, res.headers.get("content-type") || mimeForName(fileName));
        if (blob.size === 0) throw new Error("The download came back empty.");
        return { status: "done", outputPath: fileName, outputBlob: blob, outputSize: blob.size };
      } catch (e) {
        if (isAbortError(e) || ctrl.signal.aborted) return { status: "cancelled" };
        throw e;
      } finally {
        untrackAbort(fileId, ctrl);
      }
    },

    async openLoginWindow() {
      throw new Error("Platform logins need the desktop app.");
    },

    // -> { status: 'DONE' | 'ALREADY_UP_TO_DATE', version }. Needs a key; the
    // Credits engine card stays desktop-only (it gates on platformType).
    async updateYtdlp() {
      return dlJson("/engine/update", { method: "POST" });
    },

    async readCookiesText() { return null; },
    async writeCookiesText() { /* no-op on web */ },
    async getCookiesFilePath() { return null; },
    async fileExists() { return false; },
    async setKeepAwake() { /* no-op on web */ },

    async fetchRemoteImage(url) {
      // COEP require-corp: previews must come back as bytes (rendered from a
      // blob: URL), never as a cross-origin <img src>. CORS-safe CDNs go
      // direct, allowlisted hosts through the public relay, anything else
      // through the keyed image proxy when a key is set.
      let res;
      if (isCorsSafeUrl(url) || isAllowedMediaHost(url)) {
        ({ res } = await mediaFetch(url));
      } else if (getKey()) {
        res = await dlFetch(`/image?url=${encodeURIComponent(url)}`);
      } else {
        res = await fetch(url);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },

    // Cancels in-flight fetches, NAS jobs and sticker transcodes for fileId
    // (or everything when omitted).
    async cancelDownload(fileId) {
      const all = fileId == null;
      for (const [id, set] of aborts) {
        if (all || id === fileId) set.forEach((c) => c.abort());
      }
      for (const [id, jobId] of nasJobs) {
        if (!all && id !== fileId) continue;
        dlFetch(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
      }
      cancelTranscodes(all ? null : fileId);
    },

    onDownloadProgress(callback) {
      downloadProgressCallbacks.push(callback);
      return () => {
        downloadProgressCallbacks = downloadProgressCallbacks.filter((cb) => cb !== callback);
      };
    },

    onProgress(callback) {
      progressCallbacks.push(callback);
      return () => {
        progressCallbacks = progressCallbacks.filter((cb) => cb !== callback);
      };
    },

    async saveFile(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },

    async openFile() { /* no-op on web */ },
    async openInFolder() { /* no-op on web */ },

    onFileDrop() {
      // HTML5 drag-drop is handled by the Dropzone component
      return () => {};
    },
  };
}
