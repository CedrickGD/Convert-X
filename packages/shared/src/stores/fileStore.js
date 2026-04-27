import { writable, derived } from "svelte/store";

// Per-file entry
export function createFileEntry(filePath, fileObj = null) {
  return {
    id: crypto.randomUUID(),
    filePath,
    fileObj,
    detectedType: null,
    metadata: null,
    outputName: "",
    status: "detecting",
    progress: 0,
    elapsed: "00:00",
    outputPath: null,
    outputSize: 0,
    error: null,
  };
}

// Array of file entries
export const filesStore = writable([]);

// Persist output directory across sessions
const SAVED_OUTPUT_DIR_KEY = "convertx-output-dir";
function getSavedOutputDir() {
  try { return localStorage.getItem(SAVED_OUTPUT_DIR_KEY) || ""; } catch { return ""; }
}
function saveOutputDir(dir) {
  try { localStorage.setItem(SAVED_OUTPUT_DIR_KEY, dir || ""); } catch {}
}

// Shared settings
export const settingsStore = writable({
  selectedFormat: null,
  quality: 75,
  outputDir: getSavedOutputDir(),
  // Convert options
  resolution: null,
  fps: null,
  trimStart: null,
  trimEnd: null,
  stripAudio: false,
  bitrate: null,
  preset: "medium",
  // GIF options
  gifColors: 256,
  gifDither: "sierra2_4a",
  gifWidth: 480,
  gifFps: 15,
  gifTargetSizeMb: null,
  // Resize options
  resizeMode: "percentage",
  resizeWidth: null,
  resizeHeight: null,
  resizePercent: 50,
  keepAspect: true,
  resizeFormat: null,
  // Editor options (video)
  crop: null,
  rotate: 0,
  flipH: false,
  flipV: false,
  speed: 1,
  volume: 100,
});

// Save outputDir to localStorage whenever it changes
settingsStore.subscribe((s) => saveOutputDir(s.outputDir));

// App mode: convert or resize
export const appMode = writable("convert"); // convert | resize

// Per-mode operation state. "idle" means no run/done in that mode.
// idle | converting | done
export const convertOp = writable("idle");
export const resizeOp = writable("idle");

// Per-mode cancel signal. Each conversion loop reads its own flag via `get()`.
export const convertCancelled = writable(false);
export const resizeCancelled = writable(false);

// Derived overall view, scoped to the active mode.
// - if active op is converting/done, that wins
// - else if any files are loaded, we're "ready"
// - else "idle"
export const appView = derived(
  [filesStore, appMode, convertOp, resizeOp],
  ([$files, $mode, $cOp, $rOp]) => {
    const op = $mode === "convert" ? $cOp : $mode === "resize" ? $rOp : "idle";
    if (op === "converting") return "converting";
    if (op === "done") return "done";
    if ($files.length > 0) return "ready";
    return "idle";
  }
);

// Per-mode busy flags for the navbar dot
export const convertBusy = derived(convertOp, ($op) => $op === "converting");
export const resizeBusy = derived(resizeOp, ($op) => $op === "converting");

// Derived: detected file types present
export const fileTypes = derived(filesStore, ($files) => {
  const types = new Set();
  for (const f of $files) {
    if (f.detectedType) types.add(f.detectedType);
  }
  return types;
});

// Derived: file count summary
export const fileCounts = derived(filesStore, ($files) => ({
  total: $files.length,
  ready: $files.filter((f) => f.status === "ready").length,
  done: $files.filter((f) => f.status === "done").length,
  error: $files.filter((f) => f.status === "error").length,
  converting: $files.filter((f) => f.status === "converting").length,
}));

export function resetAll() {
  filesStore.set([]);
  settingsStore.update((s) => ({
    ...s,
    selectedFormat: null,
    quality: 75,
    outputDir: getSavedOutputDir(),
    resolution: null,
    fps: null,
    trimStart: null,
    trimEnd: null,
    stripAudio: false,
    bitrate: null,
    preset: "medium",
    gifColors: 256,
    gifDither: "sierra2_4a",
    gifWidth: 480,
    gifFps: 15,
    gifTargetSizeMb: null,
    resizeMode: "percentage",
    resizeWidth: null,
    resizeHeight: null,
    resizePercent: 50,
    keepAspect: true,
    resizeFormat: null,
    crop: null,
    rotate: 0,
    flipH: false,
    flipV: false,
    speed: 1,
    volume: 100,
  }));
  convertOp.set("idle");
  resizeOp.set("idle");
  convertCancelled.set(false);
  resizeCancelled.set(false);
}

// Format compatibility
const VIDEO_FORMATS = ["mp4", "mkv", "avi", "webm", "mov", "flv", "wmv", "ts"];
const IMAGE_FORMATS = ["png", "jpg", "webp", "bmp", "tiff", "ico"];
const AUDIO_FORMATS = ["mp3", "wav", "flac", "ogg", "aac", "wma", "m4a", "opus"];

export function isFormatCompatible(fileType, format) {
  if (format === "gif") return fileType === "video" || fileType === "image";
  if (fileType === "video") return VIDEO_FORMATS.includes(format);
  if (fileType === "image") return IMAGE_FORMATS.includes(format);
  if (fileType === "audio") return AUDIO_FORMATS.includes(format);
  return false;
}

// Map source file extensions to the canonical button labels used in FormatPicker.
const EXT_ALIAS = { jpeg: "jpg", tif: "tiff", m4v: "mp4" };

export function normalizeExt(ext) {
  if (!ext) return "";
  const lower = ext.toLowerCase();
  return EXT_ALIAS[lower] || lower;
}

function extOf(filePathOrName) {
  if (!filePathOrName) return "";
  const dot = filePathOrName.lastIndexOf(".");
  return dot > 0 ? filePathOrName.substring(dot + 1) : "";
}

// Set of normalized source extensions across all currently loaded files.
export const sourceFormats = derived(filesStore, ($files) => {
  const set = new Set();
  for (const f of $files) {
    const name = f.metadata?.fileName || f.filePath || (f.fileObj && f.fileObj.name) || "";
    const ext = normalizeExt(extOf(name));
    if (ext) set.add(ext);
  }
  return set;
});

// True when the user has changed any encode-affecting setting from its default.
// Used to decide whether a same-format target is a no-op or a real re-encode.
export function settingsHaveEdits(s) {
  if (!s) return false;
  if (s.trimStart != null && s.trimStart > 0) return true;
  if (s.trimEnd != null) return true;
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

export const hasEdits = derived(settingsStore, ($s) => settingsHaveEdits($s));
