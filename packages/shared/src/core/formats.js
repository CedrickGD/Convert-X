// Framework-agnostic format catalog + compatibility logic.
//
// This is the canonical source of truth for which target formats each file
// type supports, plus source-extension normalization and the "are there
// edits?" predicate. It has ZERO framework or platform dependencies (no
// Svelte, no DOM, no Node, no React Native), so every surface can consume it:
//
//   - web + desktop : imported and re-exported by stores/fileStore.js;
//     resolved through the Vite "@convertx/shared" alias.
//   - android (RN)  : import { ... } from "@convertx/shared/core/formats"
//     once Metro is pointed at the shared package (see MONOREPO.md). Today
//     Android still has its own copy in packages/android/src/lib/formats.ts;
//     this module is the seed it should collapse onto.
//
// Keep this file pure. Anything needing a Svelte store, the DOM, or a
// platform call belongs in stores/ or platform.js — not here.

export const VIDEO_FORMATS = ["mp4", "mkv", "avi", "webm", "mov", "flv", "wmv", "ts"];
export const IMAGE_FORMATS = ["png", "jpg", "webp", "bmp", "tiff", "ico"];
export const AUDIO_FORMATS = ["mp3", "wav", "flac", "ogg", "aac", "wma", "m4a", "opus"];

// Per-surface encoder capability. Desktop and web bundle a full FFmpeg, so
// they support everything above. The Android ffmpeg-kit-main-min fork ships
// no libvpx-vp9 and no libmp3lame, so webm and mp3 cannot be produced there.
// Surfaces can use isFormatSupportedOn() to grey out unsupported targets in
// the FormatPicker instead of failing at encode time.
export const FORMAT_SUPPORT = {
  desktop: { webm: true, mp3: true },
  web: { webm: true, mp3: true },
  android: { webm: false, mp3: false },
};

export function isFormatSupportedOn(surface, format) {
  const caps = FORMAT_SUPPORT[surface];
  if (!caps) return true;
  return caps[format] !== false;
}

export function isFormatCompatible(fileType, format) {
  if (format === "gif") return fileType === "video" || fileType === "image";
  // Video sources can also target audio formats (track extraction via -vn).
  if (fileType === "video") return VIDEO_FORMATS.includes(format) || AUDIO_FORMATS.includes(format);
  if (fileType === "image") return IMAGE_FORMATS.includes(format);
  if (fileType === "audio") return AUDIO_FORMATS.includes(format);
  return false;
}

// Map source file extensions to the canonical button labels used in FormatPicker.
export const EXT_ALIAS = { jpeg: "jpg", tif: "tiff", m4v: "mp4" };

export function normalizeExt(ext) {
  if (!ext) return "";
  const lower = ext.toLowerCase();
  return EXT_ALIAS[lower] || lower;
}

export function extOf(filePathOrName) {
  if (!filePathOrName) return "";
  const dot = filePathOrName.lastIndexOf(".");
  return dot > 0 ? filePathOrName.substring(dot + 1) : "";
}

// True when the user has changed any encode-affecting setting from its
// default. Used to decide whether a same-format target is a no-op or a real
// re-encode. Trim now lives on each file entry (see fileHasTrimEdits below);
// the trim checks here stay for callers that still carry trim in settings.
export function settingsHaveEdits(s) {
  if (!s) return false;
  if (s.trimStart != null && s.trimStart > 0) return true;
  if (s.trimEnd != null) return true;
  if (s.targetSizeMb != null && s.targetSizeMb > 0) return true;
  if (s.resolution) return true;
  if (s.fps != null) return true;
  if (s.bitrate) return true;
  if (s.preset && s.preset !== "medium") return true;
  if (s.stripAudio === true) return true;
  if (s.quality != null && s.quality !== 75) return true;
  if (s.crop) return true;
  if (s.rotate) return true;
  if (s.flipH || s.flipV) return true;
  if (s.speed != null && s.speed !== 1) return true;
  if (s.volume != null && s.volume !== 100) return true;
  return false;
}

// Per-file counterpart of settingsHaveEdits: trim points live on each file
// entry so they die with the file instead of leaking onto another clip.
export function fileHasTrimEdits(f) {
  if (!f) return false;
  if (f.trimStart != null && f.trimStart > 0) return true;
  if (f.trimEnd != null) return true;
  return false;
}
