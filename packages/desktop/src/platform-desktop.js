import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { downloadDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { CAPS } from "@convertx/shared/core/discordMedia.js";

// Convert-X gateway. The desktop app does its own networking (no CORS), so it
// only calls the gateway to resolve Klipy links (needs the server-side key).
const GATEWAY_BASE = "https://convertx-api.rr-admin-panel.workers.dev";

function base64ToBytes(b64) {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// Rust reqwest via `http_fetch_bytes`: resolves on any HTTP status, rejects
// only on network failure — exactly the resolver's `net` contract.
async function fetchBytes(url, { method = "GET", headers = null, maxBytes = null, timeoutMs = 30000 } = {}) {
  const r = await invoke("http_fetch_bytes", {
    url,
    method,
    headers: headers || null,
    maxBytes: maxBytes ?? null,
    timeoutMs,
  });
  return {
    status: r.status,
    contentType: r.contentType ?? null,
    finalUrl: r.finalUrl || url,
    bytes: base64ToBytes(r.dataBase64),
  };
}

const discordNet = {
  async getBytes(url, { maxBytes, headers } = {}) {
    const r = await fetchBytes(url, { headers, maxBytes });
    return { status: r.status, contentType: r.contentType, bytes: r.bytes, finalUrl: r.finalUrl };
  },
  async getText(url, { headers } = {}) {
    const r = await fetchBytes(url, { headers, maxBytes: 16 * 1024 * 1024 });
    return {
      status: r.status,
      contentType: r.contentType,
      text: new TextDecoder().decode(r.bytes),
      finalUrl: r.finalUrl,
    };
  },
  async head(url) {
    const r = await fetchBytes(url, { method: "HEAD", maxBytes: 0 });
    return { status: r.status, contentType: r.contentType };
  },
  async klipyResolve(type, slug) {
    // A gateway outage resolves (status 0) so the resolver shows its own
    // friendly "can't be looked up right now" copy.
    try {
      const r = await fetchBytes(
        `${GATEWAY_BASE}/v1/resolve/klipy?type=${encodeURIComponent(type)}&slug=${encodeURIComponent(slug)}`,
        { maxBytes: 1024 * 1024 }
      );
      let json = null;
      try {
        json = JSON.parse(new TextDecoder().decode(r.bytes));
      } catch (_) {}
      return { status: r.status, json };
    } catch (_) {
      return { status: 0, json: null };
    }
  },
};

function cancelledError() {
  const e = new Error("Cancelled");
  e.name = "AbortError";
  e.cancelled = true;
  return e;
}

function mediaHttpError(status) {
  let message;
  if (status === 404 || status === 410) message = `That file is no longer available (HTTP ${status}).`;
  else if (status === 401 || status === 403) message = `The server refused that file (HTTP ${status}).`;
  else if (status === 429) message = "The media server is rate-limiting us — wait a moment and try again.";
  else if (status >= 500) message = `The media server had a problem (HTTP ${status}) — try again.`;
  else message = `Download failed (HTTP ${status}).`;
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

export function createDesktopAdapter() {
  return {
    platformType: "desktop",

    // Discord sticker stealer. Media handles are staged files on disk:
    // { path, size } under %TEMP%/convertx-sticker/<fileId>/.
    stickerCaps: CAPS.desktop,
    discordNet,
    gateway: { base: GATEWAY_BASE },
    capabilities: { urlDownloads: true },

    async fetchMedia({ fileId, url, fileName }) {
      const destDir = await invoke("sticker_staging_dir", { fileId });
      const r = await invoke("download_direct", {
        fileId,
        url,
        destDir,
        fileName,
        headers: {},
      });
      if (r?.status === "cancelled") throw cancelledError();
      if (r?.status === "http_error") throw mediaHttpError(r.httpStatus ?? 0);
      if (!r?.outputPath) throw new Error("The download didn't produce a file.");
      // download_direct doesn't report a size; nothing downstream needs the
      // input's size (outputs carry their own from the transcode/finalize).
      return { path: r.outputPath, size: null };
    },

    async importMediaBytes({ fileId, bytes, fileName }) {
      // Raw binary IPC body; the command reads the id/name from headers.
      const path = await invoke("write_staging_file", bytes, {
        headers: { "x-file-id": fileId, "x-file-name": fileName },
      });
      return { path, size: bytes.length };
    },

    async transcodeMedia({ fileId, input, inputArgs = [], outputArgs = [], outputExt }) {
      const r = await invoke("ffmpeg_transcode", {
        fileId,
        inputPath: input.path,
        inputArgs,
        outputArgs,
        outputExt,
      });
      if (r?.cancelled) return { handle: null, size: 0, cancelled: true };
      return { handle: { path: r.outputPath, size: r.outputSize }, size: r.outputSize };
    },

    async finalizeMedia({ fileId, handle, fileName, outputDir }) {
      const r = await invoke("finalize_staged_file", {
        fileId,
        stagingPath: handle.path,
        destDir: outputDir || null,
        fileName,
      });
      return { outputPath: r.outputPath, outputSize: r.outputSize, outputBlob: null };
    },

    async discardMedia(fileId) {
      return invoke("clear_staging", { fileId });
    },

    async pickFiles({ multiple, extensions, filterName }) {
      const selected = await open({
        multiple,
        filters: [{ name: filterName || "Files", extensions }],
      });
      if (!selected) return [];
      const paths = Array.isArray(selected) ? selected : [selected];
      return paths.map((p) => ({
        name: p.split(/[/\\]/).pop(),
        path: p,
        fileObj: null,
      }));
    },

    async pickFolder() {
      return await open({ directory: true, multiple: false });
    },

    async detectFile(filePath) {
      return invoke("detect_file", { filePath });
    },

    async readFileBinary(path) {
      return invoke("read_file_binary", { path });
    },

    async fetchRemoteImage(url) {
      return invoke("fetch_remote_image", { url });
    },

    async convertFile(params) {
      return invoke("convert_file", {
        fileId: params.fileId,
        filePath: params.filePath,
        fileType: params.fileType,
        outputFormat: params.outputFormat,
        quality: params.quality,
        duration: params.duration,
        outputDir: params.outputDir,
        outputName: params.outputName,
        resolution: params.resolution,
        fps: params.fps,
        trimStart: params.trimStart,
        trimEnd: params.trimEnd,
        targetSizeMb: params.targetSizeMb,
        stripAudio: params.stripAudio,
        bitrate: params.bitrate,
        preset: params.preset,
        gifColors: params.gifColors,
        gifDither: params.gifDither,
        gifWidth: params.gifWidth,
        gifFps: params.gifFps,
        gifTargetSizeMb: params.gifTargetSizeMb,
        crop: params.crop,
        rotate: params.rotate,
        flipH: params.flipH,
        flipV: params.flipV,
        speed: params.speed,
        volume: params.volume,
      });
    },

    async resizeImage(params) {
      return invoke("resize_image", {
        fileId: params.fileId,
        filePath: params.filePath,
        resizeMode: params.resizeMode,
        width: params.width,
        height: params.height,
        percentage: params.percentage,
        keepAspect: params.keepAspect,
        outputFormat: params.outputFormat,
        quality: params.quality,
        outputDir: params.outputDir,
        outputName: params.outputName,
      });
    },

    async cancelConversion() {
      return invoke("cancel_conversion");
    },

    async downloadFromUrl(params) {
      // Returns the typed result untouched:
      //   { status: 'done', outputPath, outputSize, title } | { status: 'cancelled' }
      // Rejects only on real failure (friendly error message).
      return invoke("download_from_url", {
        fileId: params.fileId,
        url: params.url,
        format: params.format,
        quality: params.quality,
        outputDir: params.outputDir || null,
        playlistItems: params.playlistItems || null,
        dedupeNames: params.dedupeNames || false,
        noPlaylist: params.noPlaylist ?? false,
        spotifyClientId: params.spotifyClientId || null,
        spotifyClientSecret: params.spotifyClientSecret || null,
        cookiesPath: params.cookiesPath || null,
      });
    },

    // opts is additive — existing callers pass { cookiesPath } only. The
    // Spotify credentials let Rust enumerate an album/playlist via the
    // Spotify Web API (client-credentials); omitted/blank it falls back to
    // spotdl metadata enumeration, then to the single stub entry.
    async probeUrl(url, opts = {}) {
      return invoke("probe_url", {
        url,
        cookiesPath: opts.cookiesPath || null,
        spotifyClientId: opts.spotifyClientId || null,
        spotifyClientSecret: opts.spotifyClientSecret || null,
      });
    },

    async cancelDownload(fileId) {
      // No fileId = cancel ALL active downloads (both lanes). Sticker
      // transcodes register under their fileId in the same registry, so
      // this stops those too.
      return invoke("cancel_download", { fileId: fileId ?? null });
    },

    // Generic HTTP for the shared JS probers (Rust reqwest; no cookie jar;
    // explicit headers only). Resolves on ANY HTTP status; rejects only on
    // network errors / timeouts.
    async httpRequest({ url, method = "GET", headers = {}, body = null, timeoutMs = 15000 }) {
      return invoke("http_request", { url, method, headers, body, timeoutMs });
    },

    // Direct-CDN download. Never rejects for expected outcomes:
    //   { status: 'done', outputPath } | { status: 'cancelled' }
    //   | { status: 'http_error', httpStatus }
    async downloadDirect(params) {
      // The Rust command needs a concrete destination; fall back to the
      // user's Downloads folder like the yt-dlp lane does.
      const destDir = params.destDir || (await downloadDir());
      return invoke("download_direct", {
        fileId: params.fileId,
        url: params.url,
        destDir,
        fileName: params.fileName,
        headers: params.headers || {},
      });
    },

    // --- Canonical cookies.txt (<app_local_data_dir>/cookies.txt — the same
    // file yt-dlp reads via --cookies) ---
    async readCookiesText() {
      return invoke("read_cookies_file");
    },

    async writeCookiesText(text) {
      // Empty/whitespace text deletes the file (adapter contract).
      return invoke("write_cookies_file", { text: text ?? "" });
    },

    async getCookiesFilePath() {
      return invoke("cookies_file_path");
    },

    // Opens a dedicated login webview, polls until all requiredCookies are
    // present on a cookieOrigin, harvests and returns them:
    //   { status: 'ok', cookies: [{ name, value, domain, path, secure,
    //     httpOnly, expires }] } | { status: 'cancelled' }
    async openLoginWindow({ platformKey, loginUrl, cookieOrigins, requiredCookies, userAgent }) {
      return invoke("open_login_window", {
        platformKey,
        loginUrl,
        cookieOrigins,
        requiredCookies,
        userAgent: userAgent ?? null,
      });
    },

    async setKeepAwake(active) {
      return invoke("set_keep_awake", { active: !!active });
    },

    // -> { status: 'DONE' | 'ALREADY_UP_TO_DATE', version }
    async updateYtdlp() {
      return invoke("update_ytdlp");
    },

    async fileExists(path) {
      return invoke("file_exists", { path });
    },

    onDownloadProgress(callback) {
      let unlisten;
      listen("download-progress", (event) => callback(event.payload))
        .then((fn) => (unlisten = fn));
      return () => unlisten?.();
    },

    onProgress(callback) {
      let unlisten;
      listen("conversion-progress", (event) => callback(event.payload))
        .then((fn) => (unlisten = fn));
      return () => unlisten?.();
    },

    async saveFile() { /* no-op on desktop */ },

    async openFile(path) {
      return invoke("open_file", { path });
    },

    async openInFolder(path) {
      return invoke("open_in_folder", { path });
    },

    // --- Self-update (in-app, Windows MSI) ---
    async getAppVersion() {
      return getVersion();
    },

    async toolsReady() {
      return invoke("tools_ready");
    },

    async ensureTools() {
      return invoke("ensure_tools");
    },

    onToolSetup(callback) {
      let unlisten;
      listen("tool-setup", (event) => callback(event.payload))
        .then((fn) => (unlisten = fn));
      return () => unlisten?.();
    },

    async downloadInstaller(url) {
      return invoke("download_installer", { url });
    },

    async launchInstaller(path) {
      return invoke("launch_installer", { path });
    },

    onUpdateProgress(callback) {
      let unlisten;
      listen("desktop-update-progress", (event) => callback(event.payload))
        .then((fn) => (unlisten = fn));
      return () => unlisten?.();
    },

    onFileDrop(callback) {
      let unlisten;
      getCurrentWindow()
        .onDragDropEvent((event) => {
          if (event.payload.type === "drop" && event.payload.paths?.length > 0) {
            callback(
              event.payload.paths.map((p) => ({
                name: p.split(/[/\\]/).pop(),
                path: p,
                fileObj: null,
              }))
            );
          }
        })
        .then((fn) => (unlisten = fn));
      return () => unlisten?.();
    },
  };
}
