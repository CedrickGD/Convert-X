import { writable, derived } from "svelte/store";

// Per-file entry
export function createFileEntry(filePath) {
  return {
    id: crypto.randomUUID(),
    filePath,
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
  // Resize options
  resizeMode: "percentage",
  resizeWidth: null,
  resizeHeight: null,
  resizePercent: 50,
  keepAspect: true,
  resizeFormat: null,
});

// Save outputDir to localStorage whenever it changes
settingsStore.subscribe((s) => saveOutputDir(s.outputDir));

// Overall app view state
export const appView = writable("idle"); // idle | ready | converting | done

// App mode: convert or resize
export const appMode = writable("convert"); // convert | resize

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
    resizeMode: "percentage",
    resizeWidth: null,
    resizeHeight: null,
    resizePercent: 50,
    keepAspect: true,
    resizeFormat: null,
  }));
  appView.set("idle");
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
