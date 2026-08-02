import { writable, derived } from "svelte/store";
import {
  isFormatCompatible,
  normalizeExt,
  extOf,
  settingsHaveEdits,
  fileHasTrimEdits,
} from "../core/formats.js";

// The pure format catalog, compatibility check, source-extension
// normalization, and edit-detection now live in the framework-agnostic
// core (../core/formats.js) so Android can share them too. Re-exported here
// so existing web/desktop imports from this store path keep working.
export { isFormatCompatible, normalizeExt, settingsHaveEdits, fileHasTrimEdits };

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
    // Trim lives on the file entry — points set against clip A can never
    // silently truncate clips B..N, and they die with the file on remove.
    trimStart: null,
    trimEnd: null,
    // Duration as reported by the clip editor's media element. ffprobe
    // metadata.duration stays authoritative; this is a fallback for
    // containers ffprobe couldn't time.
    duration: null,
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

// Shared settings. Trim is NOT here — it lives on each file entry (see
// createFileEntry) so per-file points can't leak across the batch.
export const settingsStore = writable({
  selectedFormat: null,
  quality: 75,
  outputDir: getSavedOutputDir(),
  // Convert options
  resolution: null,
  fps: null,
  stripAudio: false,
  bitrate: null,
  preset: "medium",
  // Target output size in MB for video exports. null = off (quality/bitrate
  // drive the encode). Desktop-only downstream; web ignores it.
  targetSizeMb: null,
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

// Downloader-specific settings: Spotify API credentials, cookies file path.
// Persisted in localStorage in plaintext — these are user-issued tokens, not
// passwords, but worth being aware of.
const DL_SETTINGS_KEY = "convertx-downloader-settings";
function loadDownloaderSettings() {
  try {
    const raw = localStorage.getItem(DL_SETTINGS_KEY);
    if (!raw) return { spotifyClientId: "", spotifyClientSecret: "", cookiesPath: "" };
    const parsed = JSON.parse(raw);
    return {
      spotifyClientId: parsed.spotifyClientId || "",
      spotifyClientSecret: parsed.spotifyClientSecret || "",
      cookiesPath: parsed.cookiesPath || "",
    };
  } catch {
    return { spotifyClientId: "", spotifyClientSecret: "", cookiesPath: "" };
  }
}
export const downloaderSettings = writable(loadDownloaderSettings());
downloaderSettings.subscribe((s) => {
  try { localStorage.setItem(DL_SETTINGS_KEY, JSON.stringify(s)); } catch {}
});

// App mode: convert | resize | download | credits
export const appMode = writable("convert");

// Per-mode operation state. "idle" means no run/done in that mode.
// idle | converting | done
export const convertOp = writable("idle");
export const resizeOp = writable("idle");
export const downloadOp = writable("idle");

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
export const downloadBusy = derived(downloadOp, ($op) => $op === "downloading");

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

// Session reset ("Back" / "Convert more files"): clears the loaded files and
// per-run state but KEEPS the user's encode preferences — format, quality,
// target size, strip-audio, speed, volume, rotate/flip, gif* — so "convert
// again with the same settings" works. Only crop is cleared: it's per-file
// editing state that must not leak onto the next batch (trim lives on the
// files, which are wiped here anyway).
export function resetAll() {
  filesStore.set([]);
  settingsStore.update((s) => ({
    ...s,
    outputDir: getSavedOutputDir(),
    crop: null,
  }));
  convertOp.set("idle");
  resizeOp.set("idle");
  convertCancelled.set(false);
  resizeCancelled.set(false);
}

// Full settings reset back to factory defaults. Not part of the session
// flow — kept for an explicit "reset settings" affordance.
export function resetSettings() {
  settingsStore.update((s) => ({
    ...s,
    selectedFormat: null,
    quality: 75,
    outputDir: getSavedOutputDir(),
    resolution: null,
    fps: null,
    stripAudio: false,
    bitrate: null,
    preset: "medium",
    targetSizeMb: null,
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

// Edits = any changed encode setting OR a trim set on any loaded file (trim
// is per-file state now, so the same-format-no-edits gate must look at both).
export const hasEdits = derived(
  [settingsStore, filesStore],
  ([$s, $files]) => settingsHaveEdits($s) || $files.some(fileHasTrimEdits)
);
