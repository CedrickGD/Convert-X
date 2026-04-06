import { invoke } from "@tauri-apps/api/core";
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
