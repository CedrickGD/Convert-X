<script>
  import {
    filesStore, settingsStore, appView, appMode, fileTypes,
    createFileEntry, resetAll, isFormatCompatible,
  } from "../stores/fileStore.js";
  import { getPlatform } from "../platform.js";
  import { onMount } from "svelte";
  import Navbar from "./Navbar.svelte";
  import Dropzone from "./Dropzone.svelte";
  import FileList from "./FileList.svelte";
  import FilePreview from "./FilePreview.svelte";
  import FormatPicker from "./FormatPicker.svelte";
  import OutputSettings from "./OutputSettings.svelte";
  import AdvancedSettings from "./AdvancedSettings.svelte";
  import GifEditor from "./GifEditor.svelte";
  import ResizeSettings from "./ResizeSettings.svelte";
  import ProgressBar from "./ProgressBar.svelte";
  import OutputPanel from "./OutputPanel.svelte";
  import ThemeToggle from "./ThemeToggle.svelte";

  let files = [];
  let settings = {};
  let view = "idle";
  let types = new Set();
  let mode = "convert";
  let cancelled = false;

  const platform = getPlatform();
  const isWeb = platform.platformType === "web";

  filesStore.subscribe((v) => (files = v));
  settingsStore.subscribe((v) => (settings = v));
  appView.subscribe((v) => (view = v));
  fileTypes.subscribe((v) => (types = v));
  appMode.subscribe((v) => (mode = v));

  onMount(() => {
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
    resetAll();
    appMode.set(newMode);
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

    appView.set("ready");

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
  }

  // ── Convert ──
  async function handleConvert() {
    cancelled = false;
    appView.set("converting");

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
      if (cancelled) break;
      if (!isFormatCompatible(file.detectedType, fmt)) continue;
      if (file.status === "error") continue;

      filesStore.update((all) =>
        all.map((f) => f.id === file.id ? { ...f, status: "converting", progress: 0 } : f)
      );

      try {
        const result = await platform.convertFile({
          fileId: file.id,
          filePath: file.filePath,
          fileObj: file.fileObj,
          fileType: file.detectedType,
          outputFormat: fmt,
          quality: settings.quality,
          duration: file.metadata?.duration || null,
          outputDir: settings.outputDir || null,
          outputName: file.outputName || null,
          resolution: settings.resolution || null,
          fps: settings.fps || null,
          trimStart: settings.trimStart || null,
          trimEnd: settings.trimEnd || null,
          stripAudio: fmt === "gif" ? true : (settings.stripAudio || false),
          bitrate: settings.bitrate || null,
          preset: settings.preset || null,
        });

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

    if (!cancelled) {
      appView.set("done");
    }
  }

  // ── Resize ──
  async function handleResize() {
    cancelled = false;
    appView.set("converting");

    const currentFiles = [...files];

    filesStore.update((all) =>
      all.map((f) => {
        if (f.status === "error") return f;
        if (f.detectedType !== "image") return { ...f, status: "skipped" };
        return { ...f, status: "queued", progress: 0 };
      })
    );

    for (const file of currentFiles) {
      if (cancelled) break;
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

    if (!cancelled) {
      appView.set("done");
    }
  }

  async function handleCancel() {
    cancelled = true;
    try { await platform.cancelConversion(); } catch (_) {}
    appView.set("ready");
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
  $: canConvert = settings.selectedFormat && compatibleCount > 0 && files.some((f) => f.status === "ready");

  // Resize
  $: imageCount = files.filter((f) => f.detectedType === "image" && f.status === "ready").length;
  $: canResize = imageCount > 0 && (
    settings.resizeMode === "percentage"
      ? (settings.resizePercent || 0) > 0
      : ((settings.resizeWidth || 0) > 0 || (settings.resizeHeight || 0) > 0)
  );

  $: hasVideo = types.has("video");
  $: hasDuration = files.some((f) => f.metadata?.duration > 0);
  $: showClipEditor = hasDuration && settings.selectedFormat;
  $: clipVideoFile = files.find((f) => f.metadata?.duration > 0) || null;
  $: clipMaxDuration = clipVideoFile?.metadata?.duration || 0;

  $: overallProgress = (() => {
    const convertable = files.filter((f) => f.status !== "skipped" && f.status !== "error");
    if (convertable.length === 0) return 0;
    const total = convertable.reduce((s, f) => s + f.progress, 0);
    return total / convertable.length;
  })();

  $: progressLabel = mode === "resize" ? "Resizing..." : "Converting...";
  $: actionLabel = mode === "resize" ? "resized" : "converted";
</script>

<main>
  <header>
    <div class="header-inner">
      <div class="spacer"></div>
      <h1>Convert-<span class="x">X</span></h1>
      <div class="spacer end"><ThemeToggle /></div>
    </div>
    <Navbar activeMode={mode} onModeChange={switchMode} />
  </header>

  <div class="content">
    {#if view === "idle"}
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
          />
        {:else if singleFile}
          <FilePreview metadata={singleFile.metadata} filePath={singleFile.filePath} fileObj={singleFile.fileObj} />
        {/if}

        {#if mode === "convert"}
          <!-- Convert mode settings -->
          <FormatPicker
            fileTypes={types}
            selectedFormat={settings.selectedFormat}
            onFormatSelect={(fmt) => settingsStore.update((s) => ({
              ...s,
              selectedFormat: fmt,
              trimStart: null,
              trimEnd: null,
            }))}
          />

          {#if showClipEditor}
            <GifEditor
              duration={clipMaxDuration}
              trimStart={settings.trimStart || 0}
              trimEnd={settings.trimEnd || clipMaxDuration}
              filePath={clipVideoFile?.filePath || ""}
              fileObj={clipVideoFile?.fileObj || null}
              outputFormat={settings.selectedFormat}
              stripAudio={settings.stripAudio || false}
              onUpdate={(start, end) => {
                settingsStore.update((s) => ({
                  ...s,
                  trimStart: start > 0 ? start : null,
                  trimEnd: end < clipMaxDuration ? end : null,
                }));
              }}
              onStripAudioChange={(val) => {
                settingsStore.update((s) => ({ ...s, stripAudio: val }));
              }}
            />
          {/if}

          <OutputSettings
            outputDir={settings.outputDir}
            quality={settings.quality}
            selectedFormat={settings.selectedFormat}
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

          <AdvancedSettings
            fileTypes={types}
            selectedFormat={settings.selectedFormat}
            settings={settings}
            {hasVideo}
            {hasDuration}
            onUpdate={(s) => settingsStore.set(s)}
          />

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

<style>
  main {
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 16px 20px;
    gap: 12px;
  }

  header { padding: 2px 0; flex-shrink: 0; }

  .header-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .spacer { width: 34px; }
  .spacer.end { display: flex; justify-content: flex-end; }

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
  }

  .animate-in {
    animation: fadeUp 0.35s ease-out;
    display: flex;
    flex-direction: column;
    flex: 1;
  }

  .ready-view {
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: fadeUp 0.35s ease-out;
  }

  .converting-view {
    display: flex;
    flex-direction: column;
    gap: 14px;
    animation: fadeUp 0.3s ease-out;
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
</style>
