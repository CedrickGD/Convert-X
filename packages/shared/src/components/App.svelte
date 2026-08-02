<script>
  import {
    filesStore, settingsStore, appView, appMode, fileTypes,
    createFileEntry, resetAll, isFormatCompatible,
    convertOp, resizeOp, convertCancelled, resizeCancelled,
    convertBusy, resizeBusy,
    sourceFormats, hasEdits,
    downloaderSettings,
  } from "../stores/fileStore.js";
  import { get } from "svelte/store";
  import { VIDEO_FORMATS } from "../core/formats.js";
  import { getPlatform } from "../platform.js";
  import { onMount } from "svelte";
  import Navbar from "./Navbar.svelte";
  import Dropzone from "./Dropzone.svelte";
  import FileList from "./FileList.svelte";
  import FilePreview from "./FilePreview.svelte";
  import FormatPicker from "./FormatPicker.svelte";
  import OutputSettings from "./OutputSettings.svelte";
  import AdvancedSettings from "./AdvancedSettings.svelte";
  import ClipEditor from "./ClipEditor.svelte";
  import GifSettings from "./GifSettings.svelte";
  import ResizeSettings from "./ResizeSettings.svelte";
  import ProgressBar from "./ProgressBar.svelte";
  import OutputPanel from "./OutputPanel.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";
  import Credits from "./Credits.svelte";
  import DownloadView from "./DownloadView.svelte";
  import HistoryView from "./HistoryView.svelte";
  import Toast from "./Toast.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import { REPO_URL } from "../lib/github.js";
  import { installGlobalErrorCapture, logError } from "../lib/errorLog.js";
  import { runMonthlyYtdlpFreshnessCheck } from "../lib/downloadQueue.js";
  import { importCookiesText } from "../lib/cookies.js";
  import { invalidateInstagramSessionCache } from "../lib/instagramStories.js";
  import { saveJson } from "../lib/storage.js";

  let files = [];
  let settings = {};
  let view = "idle";
  let types = new Set();
  let mode = "convert";
  let sources = new Set();
  let edited = false;

  const platform = getPlatform();
  const isWeb = platform.platformType === "web";
  const isDesktop = platform.platformType === "desktop";

  // First-run tool setup: the desktop portable build downloads ffmpeg/yt-dlp/spotdl
  // into AppData on first launch. null = ready/not-needed.
  let toolSetup = null;

  filesStore.subscribe((v) => (files = v));
  settingsStore.subscribe((v) => (settings = v));
  appView.subscribe((v) => (view = v));
  fileTypes.subscribe((v) => (types = v));
  appMode.subscribe((v) => (mode = v));
  sourceFormats.subscribe((v) => (sources = v));
  hasEdits.subscribe((v) => (edited = v));

  // One-time migration of the legacy manually-picked cookies path into the
  // canonical cookies.txt store. The batch runner resolves cookies ONLY
  // from the canonical file, so a pre-existing Advanced-field path would
  // silently stop working without this. Only runs while the canonical file
  // is empty — once it has content the legacy path is never consulted again.
  async function migrateLegacyCookiesPath() {
    try {
      if (
        typeof platform.readCookiesText !== "function" ||
        typeof platform.writeCookiesText !== "function" ||
        typeof platform.readFileBinary !== "function"
      ) {
        return;
      }
      const legacyPath = get(downloaderSettings).cookiesPath;
      if (!legacyPath) return;
      try {
        const existing = await platform.readCookiesText();
        if (!(typeof existing === "string" && existing.trim().length > 0)) {
          const bytes = await platform.readFileBinary(legacyPath);
          const text = new TextDecoder().decode(
            bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
          );
          if (text.trim()) {
            await importCookiesText(text);
            // Same semantics as a manual import: the file was replaced wholesale,
            // so any persisted "Connected" flags may be stale — reset them and
            // drop the cached Instagram session verdict.
            saveJson("convertx.connectedPlatforms.v1", []);
            invalidateInstagramSessionCache();
          }
        }
      } finally {
        // Clear the legacy setting in every outcome (imported, canonical file
        // already populated, or unreadable source) so the migration never
        // re-runs — the Advanced field is an import action now, not a live path.
        downloaderSettings.update((s) => ({ ...s, cookiesPath: "" }));
      }
    } catch (e) {
      logError("error", e, "legacy cookies-path migration");
    }
  }

  onMount(() => {
    // Field failures (probe/download/crash) are only diagnosable through
    // the in-app error log — capture uncaught errors from the very start.
    // Web-safe, so un-gated.
    installGlobalErrorCapture();

    if (isDesktop) {
      // Fire-and-forget boot tasks: neither may block or break startup.
      runMonthlyYtdlpFreshnessCheck().catch((e) =>
        logError("error", e, "yt-dlp freshness check")
      );
      migrateLegacyCookiesPath();
    }

    if (isDesktop && platform.ensureTools) {
      (async () => {
        try {
          const ready = await platform.toolsReady();
          if (!ready) {
            toolSetup = { tool: "", state: "starting" };
            const stop = platform.onToolSetup?.((p) => (toolSetup = p));
            try {
              await platform.ensureTools();
            } finally {
              stop?.();
            }
          }
        } catch (_) {
          // Non-fatal: open the app anyway; conversions surface tool errors.
        } finally {
          toolSetup = null;
        }
      })();
    }

    const unlistenProgress = platform.onProgress(({ file_id, progress, elapsed }) => {
      filesStore.update((all) =>
        all.map((f) => f.id === file_id ? { ...f, progress, elapsed } : f)
      );
    });

    const unlistenDrop = platform.onFileDrop((entries) => {
      handleFilesDrop(entries);
    });

    return () => {
      if (typeof unlistenProgress === "function") unlistenProgress();
      if (typeof unlistenDrop === "function") unlistenDrop();
    };
  });

  function switchMode(newMode) {
    if (newMode === mode) return;
    appMode.set(newMode);
  }

  // Tab-content entry animation.
  //
  // A mount-time CSS animation only fires for panes that are re-created (or
  // toggled out of display:none), which made the effect inconsistent:
  // Convert↔Resize render the SAME view block — only props change — so
  // switching between them animated nothing at all, while every other tab
  // switch faded in. Alternating two identical keyframes on every mode
  // change restarts the animation for whichever pane is on screen, without
  // remounting anything — so the always-mounted Download pane keeps its
  // running batch (see the .tab-pane comment in the markup).
  let paneEnter = 0;
  let lastAnimatedMode = null;
  $: if (mode !== lastAnimatedMode) {
    lastAnimatedMode = mode;
    paneEnter += 1;
  }

  function getDefaultDir(filePath) {
    if (!filePath) return "";
    const sep = filePath.lastIndexOf("\\") !== -1 ? "\\" : "/";
    const idx = filePath.lastIndexOf(sep);
    return idx > 0 ? filePath.substring(0, idx) : "";
  }

  function getStem(fileName) {
    if (!fileName) return "";
    const dot = fileName.lastIndexOf(".");
    return dot > 0 ? fileName.substring(0, dot) : fileName;
  }

  function getGifDefaults() {
    const imageOnly = types.size === 1 && types.has("image");

    if (imageOnly) {
      return {
        quality: 100,
        gifColors: 256,
        gifDither: "floyd_steinberg",
        gifWidth: null,
        gifFps: null,
        gifTargetSizeMb: null,
      };
    }

    return {
      quality: 75,
      gifColors: 256,
      gifDither: "sierra2_4a",
      gifWidth: 480,
      gifFps: 15,
      gifTargetSizeMb: null,
    };
  }

  async function handleFilesDrop(entries) {
    if (view !== "idle" && view !== "ready") {
      resetAll();
    }

    // entries: [{name, path, fileObj}] from platform adapter
    const newEntries = entries.map((e) => createFileEntry(e.path || e.name, e.fileObj || null));
    filesStore.update((existing) => [...existing, ...newEntries]);

    if (!isWeb && !settings.outputDir && entries[0]?.path) {
      settingsStore.update((s) => ({ ...s, outputDir: getDefaultDir(entries[0].path) }));
    }

    for (const entry of newEntries) {
      try {
        const fileRef = entry.fileObj || entry.filePath;
        const meta = await platform.detectFile(fileRef);
        filesStore.update((all) =>
          all.map((f) =>
            f.id === entry.id
              ? {
                  ...f,
                  detectedType: meta.file_type,
                  metadata: {
                    codec: meta.codec,
                    resolution: meta.resolution,
                    bitrate: meta.bitrate,
                    duration: meta.duration,
                    frameRate: meta.frame_rate,
                    size: meta.size,
                    fileName: meta.file_name,
                    mimeType: meta.mime_type,
                  },
                  outputName: getStem(meta.file_name),
                  status: "ready",
                }
              : f
          )
        );
      } catch (err) {
        filesStore.update((all) =>
          all.map((f) =>
            f.id === entry.id ? { ...f, status: "error", error: `Detection: ${err}` } : f
          )
        );
      }
    }
  }

  function addMoreFiles(entries) {
    handleFilesDrop(entries);
  }

  function removeFile(id) {
    filesStore.update((all) => all.filter((f) => f.id !== id));
    let remaining;
    filesStore.subscribe((v) => (remaining = v))();
    if (remaining.length === 0) resetAll();
    // Trim lives on the removed entry — it dies with the file. A removed
    // clip-editor selection falls back via the clipVideoFile chain below.
  }

  // ── Convert ──
  async function handleConvert() {
    convertCancelled.set(false);
    convertOp.set("converting");

    const fmt = settings.selectedFormat;
    const currentFiles = [...files];

    filesStore.update((all) =>
      all.map((f) => {
        if (f.status === "error") return f;
        if (!isFormatCompatible(f.detectedType, fmt)) return { ...f, status: "skipped" };
        return { ...f, status: "queued", progress: 0 };
      })
    );

    for (const file of currentFiles) {
      if (get(convertCancelled)) break;
      if (!isFormatCompatible(file.detectedType, fmt)) continue;
      if (file.status === "error") continue;

      filesStore.update((all) =>
        all.map((f) => f.id === file.id ? { ...f, status: "converting", progress: 0 } : f)
      );

      try {
        // Target size applies to video-category targets only (GIF has its own
        // gifTargetSizeMb pipeline). The math lives in the Rust arg builder;
        // web's wasm builder ignores the field (UI is desktop-gated anyway).
        const wantsTargetSize =
          isDesktop &&
          settings.targetSizeMb != null &&
          settings.targetSizeMb > 0 &&
          VIDEO_FORMATS.includes(fmt);

        const result = await platform.convertFile({
          fileId: file.id,
          filePath: file.filePath,
          fileObj: file.fileObj,
          fileType: file.detectedType,
          outputFormat: fmt,
          quality: settings.quality,
          duration: file.metadata?.duration || file.duration || null,
          outputDir: settings.outputDir || null,
          outputName: file.outputName || null,
          resolution: settings.resolution || null,
          fps: settings.fps || null,
          // Trim is per-file: each clip carries its own points.
          trimStart: file.trimStart || null,
          trimEnd: file.trimEnd || null,
          targetSizeMb: wantsTargetSize ? settings.targetSizeMb : null,
          stripAudio: fmt === "gif" ? true : (settings.stripAudio || false),
          bitrate: settings.bitrate || null,
          preset: settings.preset || null,
          gifColors: settings.gifColors || null,
          gifDither: settings.gifDither || null,
          gifWidth: settings.gifWidth != null ? settings.gifWidth : null,
          gifFps: settings.gifFps != null ? settings.gifFps : null,
          gifTargetSizeMb: settings.gifTargetSizeMb != null ? settings.gifTargetSizeMb : null,
          crop: settings.crop || null,
          rotate: settings.rotate || 0,
          flipH: settings.flipH || false,
          flipV: settings.flipV || false,
          speed: settings.speed || 1,
          volume: settings.volume != null ? settings.volume / 100 : 1,
        });

        // A cancelled conversion RESOLVES (it is never an error) with an
        // empty output path and its partial file already deleted — marking
        // it "done" would fake a success row with a dead "Open file".
        if (result?.cancelled) {
          filesStore.update((all) =>
            all.map((f) =>
              f.id === file.id ? { ...f, status: "ready", progress: 0 } : f
            )
          );
          break;
        }

        filesStore.update((all) =>
          all.map((f) =>
            f.id === file.id
              ? {
                  ...f,
                  status: "done",
                  outputPath: result.output_path || result.outputName || "",
                  outputSize: result.output_size || result.outputSize || 0,
                  outputBlob: result.outputBlob || null,
                  progress: 100,
                }
              : f
          )
        );
      } catch (err) {
        filesStore.update((all) =>
          all.map((f) =>
            f.id === file.id ? { ...f, status: "error", error: `${err}`, progress: 0 } : f
          )
        );
      }
    }

    if (!get(convertCancelled)) {
      convertOp.set("done");
    }
  }

  // ── Resize ──
  async function handleResize() {
    resizeCancelled.set(false);
    resizeOp.set("converting");

    const currentFiles = [...files];

    filesStore.update((all) =>
      all.map((f) => {
        if (f.status === "error") return f;
        if (f.detectedType !== "image") return { ...f, status: "skipped" };
        return { ...f, status: "queued", progress: 0 };
      })
    );

    for (const file of currentFiles) {
      if (get(resizeCancelled)) break;
      if (file.detectedType !== "image") continue;
      if (file.status === "error") continue;

      filesStore.update((all) =>
        all.map((f) => f.id === file.id ? { ...f, status: "converting", progress: 0 } : f)
      );

      try {
        const ext = file.filePath.split(".").pop().toLowerCase();
        const fmt = settings.resizeFormat || ext;

        const result = await platform.resizeImage({
          fileId: file.id,
          filePath: file.filePath,
          fileObj: file.fileObj,
          resizeMode: settings.resizeMode,
          width: settings.resizeMode === "pixels" ? (settings.resizeWidth || null) : null,
          height: settings.resizeMode === "pixels" ? (settings.resizeHeight || null) : null,
          percentage: settings.resizeMode === "percentage" ? (settings.resizePercent || null) : null,
          keepAspect: settings.keepAspect,
          outputFormat: fmt,
          quality: settings.quality,
          outputDir: settings.outputDir || null,
          outputName: file.outputName || null,
        });

        // Same typed-cancel contract as convert_file: a resolved
        // { cancelled: true } is a cancel, not a finished file.
        if (result?.cancelled) {
          filesStore.update((all) =>
            all.map((f) =>
              f.id === file.id ? { ...f, status: "ready", progress: 0 } : f
            )
          );
          break;
        }

        filesStore.update((all) =>
          all.map((f) =>
            f.id === file.id
              ? {
                  ...f,
                  status: "done",
                  outputPath: result.output_path || result.outputName || "",
                  outputSize: result.output_size || result.outputSize || 0,
                  outputBlob: result.outputBlob || null,
                  progress: 100,
                }
              : f
          )
        );
      } catch (err) {
        filesStore.update((all) =>
          all.map((f) =>
            f.id === file.id ? { ...f, status: "error", error: `${err}`, progress: 0 } : f
          )
        );
      }
    }

    if (!get(resizeCancelled)) {
      resizeOp.set("done");
    }
  }

  async function handleCancel() {
    // Cancel must not throw away finished work: if any file already
    // completed, land on the done summary instead of dropping to ready.
    const anyDone = files.some((f) => f.status === "done");
    if (mode === "convert") {
      convertCancelled.set(true);
      convertOp.set(anyDone ? "done" : "idle");
    } else {
      resizeCancelled.set(true);
      resizeOp.set(anyDone ? "done" : "idle");
    }
    try { await platform.cancelConversion(); } catch (_) {}
    filesStore.update((all) =>
      all.map((f) =>
        f.status === "queued" || f.status === "converting"
          ? { ...f, status: "ready", progress: 0 }
          : f
      )
    );
  }

  // ── Reactive values ──
  $: isBatch = files.length > 1;
  $: singleFile = files.length === 1 ? files[0] : null;

  // Convert
  $: compatibleCount = files.filter((f) =>
    f.detectedType && settings.selectedFormat && isFormatCompatible(f.detectedType, settings.selectedFormat)
  ).length;
  // Block the action when target == source AND no edits — that would be a no-op re-encode.
  $: sameFormatNoEdits = settings.selectedFormat && sources.has(settings.selectedFormat) && !edited;
  $: canConvert = settings.selectedFormat && compatibleCount > 0 && files.some((f) => f.status === "ready") && !sameFormatNoEdits;

  // Resize
  $: imageCount = files.filter((f) => f.detectedType === "image" && f.status === "ready").length;
  $: canResize = imageCount > 0 && (
    settings.resizeMode === "percentage"
      ? (settings.resizePercent || 0) > 0
      : ((settings.resizeWidth || 0) > 0 || (settings.resizeHeight || 0) > 0)
  );

  $: isGif = settings.selectedFormat === "gif";
  $: hasVideo = types.has("video");
  $: hasDuration = files.some((f) => f.metadata?.duration > 0);
  $: showClipEditor = hasDuration;

  // Which clip the ClipEditor is bound to. Defaults to the first video (or
  // first file with a duration — audio trim keeps working); multi-video
  // batches can pick another by clicking its FileList row. A removed
  // selection falls back through the chain instead of leaving a dead editor.
  let selectedClipId = null;
  $: videoFiles = files.filter((f) => f.detectedType === "video");
  $: clipSelectable = videoFiles.length > 1;
  $: clipVideoFile =
    (clipSelectable &&
      videoFiles.find((f) => f.id === selectedClipId && f.metadata?.duration > 0)) ||
    videoFiles.find((f) => f.metadata?.duration > 0) ||
    files.find((f) => f.metadata?.duration > 0) ||
    null;
  $: clipMaxDuration = clipVideoFile?.metadata?.duration || 0;
  $: if (files.length === 0 && selectedClipId !== null) selectedClipId = null;

  function setFileTrim(id, start, end, max) {
    filesStore.update((all) =>
      all.map((f) =>
        f.id === id
          ? {
              ...f,
              trimStart: start > 0 ? start : null,
              trimEnd: end < max ? end : null,
            }
          : f
      )
    );
  }

  function clearFileTrim(id) {
    filesStore.update((all) =>
      all.map((f) => (f.id === id ? { ...f, trimStart: null, trimEnd: null } : f))
    );
  }

  function setFileDuration(id, d) {
    // The editor re-reports duration on every mount — skip the no-op so
    // reopening a clip doesn't churn the store for nothing.
    filesStore.update((all) => {
      const cur = all.find((f) => f.id === id);
      if (!cur || cur.duration === d) return all;
      return all.map((f) => (f.id === id ? { ...f, duration: d } : f));
    });
  }

  $: overallProgress = (() => {
    const convertable = files.filter((f) => f.status !== "skipped" && f.status !== "error");
    if (convertable.length === 0) return 0;
    const total = convertable.reduce((s, f) => s + f.progress, 0);
    return total / convertable.length;
  })();

  // Batch progress reads as 1/N steps; a "X of N" label makes the sequential
  // advance legible instead of looking stalled.
  $: progressLabel = (() => {
    const verb = mode === "resize" ? "Resizing" : "Converting";
    if (!isBatch) return `${verb}...`;
    const total = files.filter((f) => f.status !== "skipped" && f.status !== "error").length;
    if (total === 0) return `${verb}...`;
    const doneN = files.filter((f) => f.status === "done").length;
    return `${verb} ${Math.min(doneN + 1, total)} of ${total}...`;
  })();
  $: actionLabel = mode === "resize" ? "resized" : "converted";

  // Target-size export: video-category targets only (GIF excluded), and only
  // on desktop — web's wasm arg builder has no size-targeting math.
  $: showTargetSize =
    isDesktop && !!settings.selectedFormat && VIDEO_FORMATS.includes(settings.selectedFormat);

  $: toolSetupLabel = !toolSetup ? "" :
    toolSetup.state === "extracting" ? "Unpacking ffmpeg…" :
    toolSetup.tool === "ffmpeg" ? "Downloading the media engine (ffmpeg)…" :
    toolSetup.tool === "yt-dlp" ? "Downloading the downloader (yt-dlp)…" :
    toolSetup.tool === "spotdl" ? "Downloading Spotify support (spotdl)…" :
    "Setting things up…";
</script>

{#if toolSetup}
  <div class="tool-setup-overlay">
    <div class="tool-setup-card">
      <div class="spinner" aria-hidden="true"></div>
      <h2>Preparing Convert-X…</h2>
      <p>{toolSetupLabel}</p>
      <p class="tool-setup-hint">One-time setup — fetching the conversion tools.</p>
    </div>
  </div>
{/if}

<main>
  <header>
    <div class="header-inner">
      <div class="header-side start">
        <a class="icon-btn" href={REPO_URL} target="_blank" rel="noopener noreferrer" aria-label="View source on GitHub" title="GitHub">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.17.91-.25 1.89-.38 2.86-.38s1.95.13 2.86.38c2.18-1.48 3.14-1.17 3.14-1.17.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.55 4.56-1.52 7.85-5.83 7.85-10.91C23.5 5.65 18.35.5 12 .5z"/></svg>
        </a>
      </div>
      <h1>Convert-<span class="x">X</span></h1>
      <div class="header-side end"><ThemeToggle /></div>
    </div>
    <Navbar activeMode={mode} onModeChange={switchMode} />
  </header>

  <div
    class="content"
    class:pane-a={paneEnter % 2 === 1}
    class:pane-b={paneEnter % 2 === 0}
  >
    {#if isDesktop}
      <!-- A running download batch lives in DownloadView's local state (its
           progress, its Cancel button, the promise closure that finishes it),
           so unmounting on a tab switch would strand the batch: uncancellable
           while running, and inert on return. Keep it mounted and hide it.
           Desktop-only — on web the view is inert, so it stays in the branch
           chain below and web behaviour is unchanged. -->
      <div class="tab-pane" class:hidden={mode !== "download"}>
        <DownloadView />
      </div>
    {/if}

    {#if mode === "credits"}
      <Credits />

    {:else if mode === "download"}
      {#if !isDesktop}
        <DownloadView />
      {/if}

    {:else if mode === "history" && isDesktop}
      <!-- The History tab only exists on desktop (gated in Navbar); the
           isDesktop guard here keeps the web view switch provably
           unchanged even if the mode were ever set programmatically. -->
      <HistoryView />

    {:else if view === "idle"}
      <div class="animate-in">
        <Dropzone onFilesDrop={handleFilesDrop} {mode} />
      </div>

    {:else if view === "ready"}
      <div class="ready-view">
        {#if isBatch}
          <FileList
            {files}
            view="ready"
            onRemoveFile={removeFile}
            onAddFiles={addMoreFiles}
            selectedFileId={mode === "convert" && clipSelectable ? clipVideoFile?.id ?? null : null}
            onSelectFile={mode === "convert" && clipSelectable ? (id) => (selectedClipId = id) : null}
          />
        {:else if singleFile}
          <FilePreview metadata={singleFile.metadata} filePath={singleFile.filePath} fileObj={singleFile.fileObj} />
        {/if}

        {#if mode === "convert"}
          <div class="convert-split" class:single-col={!showClipEditor}>
          {#if showClipEditor}
          <div class="split-left">
            <!-- Keyed by file id so switching clips remounts with fresh
                 duration/playhead state instead of showing the previous
                 clip's timeline. Trim reads/writes the bound FILE's
                 trimStart/trimEnd, not settings. -->
            {#key clipVideoFile?.id}
            <ClipEditor
              duration={clipMaxDuration}
              trimStart={clipVideoFile?.trimStart || 0}
              trimEnd={clipVideoFile?.trimEnd || clipMaxDuration}
              storedTrimStart={clipVideoFile?.trimStart ?? null}
              storedTrimEnd={clipVideoFile?.trimEnd ?? null}
              filePath={clipVideoFile?.filePath || ""}
              fileObj={clipVideoFile?.fileObj || null}
              outputFormat={settings.selectedFormat}
              stripAudio={settings.stripAudio || false}
              crop={settings.crop || null}
              rotate={settings.rotate || 0}
              flipH={settings.flipH || false}
              flipV={settings.flipV || false}
              speed={settings.speed || 1}
              volume={settings.volume != null ? settings.volume : 100}
              onUpdate={(start, end) => {
                if (clipVideoFile) setFileTrim(clipVideoFile.id, start, end, clipMaxDuration);
              }}
              onDurationKnown={(d) => {
                if (clipVideoFile) setFileDuration(clipVideoFile.id, d);
              }}
              onTrimClear={() => {
                if (clipVideoFile) clearFileTrim(clipVideoFile.id);
              }}
              onStripAudioChange={(val) => {
                settingsStore.update((s) => ({ ...s, stripAudio: val }));
              }}
              onCropChange={(c) => settingsStore.update((s) => ({ ...s, crop: c }))}
              onRotateChange={(r) => settingsStore.update((s) => ({ ...s, rotate: r }))}
              onFlipHChange={(v) => settingsStore.update((s) => ({ ...s, flipH: v }))}
              onFlipVChange={(v) => settingsStore.update((s) => ({ ...s, flipV: v }))}
              onSpeedChange={(v) => settingsStore.update((s) => ({ ...s, speed: v }))}
              onVolumeChange={(v) => settingsStore.update((s) => ({ ...s, volume: v }))}
            />
            {/key}
          </div>
          {/if}

          <div class="split-right">
          <FormatPicker
            fileTypes={types}
            selectedFormat={settings.selectedFormat}
            sourceFormats={sources}
            hasEdits={edited}
            onFormatSelect={(fmt) => settingsStore.update((s) => ({
              ...s,
              selectedFormat: fmt,
              // Trim survives format switches — it lives on the file entries
              // now, matching Android's per-file model.
              ...(fmt === "gif" ? getGifDefaults() : {}),
            }))}
          />

          {#if isGif}
            <GifSettings
              {settings}
              {hasDuration}
              onUpdate={(s) => settingsStore.set(s)}
            />
          {/if}

          <OutputSettings
            outputDir={settings.outputDir}
            quality={settings.quality}
            selectedFormat={settings.selectedFormat}
            {isBatch}
            singleOutputName={singleFile?.outputName || ""}
            targetSizeMb={settings.targetSizeMb ?? null}
            {showTargetSize}
            onTargetSizeChange={(mb) => settingsStore.update((s) => ({ ...s, targetSizeMb: mb }))}
            onNameChange={(n) => {
              if (singleFile) {
                filesStore.update((all) => all.map((f) => f.id === singleFile.id ? { ...f, outputName: n } : f));
              }
            }}
            onDirChange={(d) => settingsStore.update((s) => ({ ...s, outputDir: d }))}
            onQualityChange={(q) => settingsStore.update((s) => ({ ...s, quality: q }))}
          />

          {#if !isGif}
            <AdvancedSettings
              fileTypes={types}
              selectedFormat={settings.selectedFormat}
              settings={settings}
              {hasVideo}
              {hasDuration}
              onUpdate={(s) => settingsStore.set(s)}
            />
          {/if}

          {#if sameFormatNoEdits}
            <p class="hint">Same format as source — change a setting (trim, quality, bitrate, …) to re-encode.</p>
          {/if}

          <div class="actions">
            <button class="btn ghost" on:click={resetAll}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
              Back
            </button>
            <button class="btn primary" disabled={!canConvert} on:click={handleConvert}>
              {#if isBatch}
                Convert {compatibleCount} file{compatibleCount !== 1 ? "s" : ""}
              {:else}
                Convert{settings.selectedFormat ? ` to ${settings.selectedFormat.toUpperCase()}` : ""}
              {/if}
            </button>
          </div>
          </div><!-- /.split-right -->
          </div><!-- /.convert-split -->

        {:else}
          <!-- Resize mode settings -->
          <ResizeSettings
            {files}
            {settings}
            onUpdate={(s) => settingsStore.set(s)}
          />

          <OutputSettings
            outputDir={settings.outputDir}
            quality={settings.quality}
            selectedFormat={settings.resizeFormat}
            {isBatch}
            singleOutputName={singleFile?.outputName || ""}
            onNameChange={(n) => {
              if (singleFile) {
                filesStore.update((all) => all.map((f) => f.id === singleFile.id ? { ...f, outputName: n } : f));
              }
            }}
            onDirChange={(d) => settingsStore.update((s) => ({ ...s, outputDir: d }))}
            onQualityChange={(q) => settingsStore.update((s) => ({ ...s, quality: q }))}
          />

          <div class="actions">
            <button class="btn ghost" on:click={resetAll}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
              Back
            </button>
            <button class="btn primary" disabled={!canResize} on:click={handleResize}>
              {#if isBatch}
                Resize {imageCount} image{imageCount !== 1 ? "s" : ""}
              {:else}
                Resize
              {/if}
            </button>
          </div>
        {/if}
      </div>

    {:else if view === "converting"}
      <div class="converting-view animate-in">
        <FileList {files} view="converting" onRemoveFile={null} onAddFiles={null} />

        {#if isBatch}
          <ProgressBar progress={overallProgress} elapsed="" label={progressLabel} />
        {:else}
          <ProgressBar
            progress={singleFile?.progress || 0}
            elapsed={singleFile?.elapsed || "00:00"}
            label={progressLabel}
          />
        {/if}

        <div class="actions">
          <button class="btn ghost" on:click={handleCancel}>Cancel</button>
        </div>
      </div>

    {:else if view === "done"}
      <div class="animate-in">
        <OutputPanel {files} onStartOver={resetAll} {actionLabel} />
      </div>

    {/if}
  </div>
</main>

<!-- Feedback hosts: mounted exactly once, app-wide. toast(...) and
     confirmDialog(...) from any component render through these. -->
<Toast />
<ConfirmDialog />

<style>
  main {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px 20px;
    gap: 12px;
    /* Widest the app column ever gets. Views may cap themselves tighter. */
    --app-column: 1200px;
  }

  /* App column. Every tab (Convert, Resize, Download, Credits, History)
     renders inside .content, so capping and centring it here is what stops
     any single view being pinned against one edge of a wide window. The
     header shares the cap so the GitHub/theme buttons stay flush with the
     column instead of drifting to the window corners. */
  header {
    padding: 2px 0;
    flex-shrink: 0;
    width: 100%;
    max-width: var(--app-column);
    margin-inline: auto;
  }

  .header-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .header-side {
    width: 34px;
    display: flex;
    align-items: center;
  }

  .header-side.end { justify-content: flex-end; }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    background: transparent;
    transition: all var(--transition-fast);
  }

  .icon-btn:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  header h1 {
    font-size: 1.3rem;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--text-primary);
    text-align: center;
    flex: 1;
  }

  .x { color: var(--accent); }

  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    width: 100%;
    max-width: var(--app-column);
    margin-inline: auto;
  }

  /* display:contents keeps the always-mounted Download pane layout-neutral —
     its child stays the flex item .content used to lay out directly. */
  .tab-pane { display: contents; }
  .tab-pane.hidden { display: none; }

  /* Entry animation for whichever pane is on screen, replayed on every tab
     switch (see paneEnter in the script). Two identical keyframes alternate
     because re-applying the SAME animation-name to a surviving element does
     not restart it. The Download pane is display:contents, so the animation
     has to land on its child instead of the pane box. Both selectors
     out-specify the panes' own mount-time fades, so this is the single
     source of truth for tab-content entry. */
  .content.pane-a > :global(*:not(.tab-pane)),
  .content.pane-a > .tab-pane > :global(*) {
    animation: paneEnterA 0.35s ease-out;
  }

  .content.pane-b > :global(*:not(.tab-pane)),
  .content.pane-b > .tab-pane > :global(*) {
    animation: paneEnterB 0.35s ease-out;
  }

  @keyframes paneEnterA {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: none; }
  }

  @keyframes paneEnterB {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: none; }
  }

  .animate-in {
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .ready-view {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .convert-split {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    align-items: start;
    min-width: 0;
  }

  .split-left,
  .split-right {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  @media (min-width: 900px) {
    .convert-split {
      grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr);
    }
    .convert-split.single-col {
      grid-template-columns: 1fr;
      max-width: 720px;
      margin: 0 auto;
    }
  }

  .converting-view {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
    margin: 0;
    padding: 4px 8px;
    /* Appears/disappears as the user edits settings — fade it instead of
       popping a line of text into the middle of the panel. */
    animation: fadeIn 0.2s ease-out;
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    padding: 6px 0 2px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 10px 24px;
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 0.85rem;
    letter-spacing: -0.01em;
  }

  .btn.primary {
    background: var(--accent);
    color: var(--btn-primary-text);
    padding: 11px 32px;
  }

  .btn.primary:hover:not(:disabled) {
    background: var(--accent-hover);
    box-shadow: 0 0 24px var(--accent-glow), 0 4px 12px rgba(0,0,0,0.3);
  }

  .btn.ghost {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .btn.ghost:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-hover);
  }

  .tool-setup-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-card);
    /* Boot overlay: fade in rather than slamming over the app shell. */
    animation: fadeIn 0.2s ease-out;
  }
  .tool-setup-card {
    animation: fadeUp 0.3s ease-out;
    text-align: center;
    max-width: 340px;
    padding: 28px 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }
  .tool-setup-card h2 {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }
  .tool-setup-card p {
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin: 0;
  }
  .tool-setup-hint { font-size: 0.74rem; color: var(--text-muted); }
  .spinner {
    width: 34px;
    height: 34px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-bottom: 6px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
