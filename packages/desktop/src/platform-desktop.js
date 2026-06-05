import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
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
      return invoke("download_from_url", {
        fileId: params.fileId,
        url: params.url,
        format: params.format,
        quality: params.quality,
        outputDir: params.outputDir,
        playlistItems: params.playlistItems || null,
        spotifyClientId: params.spotifyClientId || null,
        spotifyClientSecret: params.spotifyClientSecret || null,
        cookiesPath: params.cookiesPath || null,
      });
    },

    async probeUrl(url, opts = {}) {
      return invoke("probe_url", {
        url,
        cookiesPath: opts.cookiesPath || null,
      });
    },

    async cancelDownload() {
      return invoke("cancel_download");
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
