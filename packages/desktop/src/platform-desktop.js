import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { downloadDir } from "@tauri-apps/api/path";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";

export function createDesktopAdapter() {
  return {
    platformType: "desktop",

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
      // No fileId = cancel ALL active downloads (both lanes).
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
