import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

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
  let progressCallbacks = [];
  let currentFileId = "";

  async function ensureFFmpeg() {
    if (ffmpeg && ffmpeg.loaded) return ffmpeg;
    ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress, time }) => {
      progressCallbacks.forEach((cb) =>
        cb({
          file_id: currentFileId,
          progress: Math.min(100, Math.round(progress * 100)),
          elapsed: formatElapsed(time),
        })
      );
    });
    await ffmpeg.load();
    return ffmpeg;
  }

  return {
    platformType: "web",

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

    async cancelConversion() {
      if (ffmpeg) {
        ffmpeg.terminate();
        ffmpeg = null;
      }
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
