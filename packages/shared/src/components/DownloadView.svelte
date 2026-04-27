<script>
  import { onMount, onDestroy } from "svelte";
  import { getPlatform } from "../platform.js";
  import { settingsStore, downloadOp } from "../stores/fileStore.js";
  import DesktopDownload from "./DesktopDownload.svelte";

  const platform = getPlatform();
  const isDesktop = platform.platformType === "desktop";

  let url = "";
  let detectedSite = "";
  let format = "mp4";
  let quality = "best";
  let outputDir = "";

  // States: idle | downloading | done | error
  let state = "idle";
  let progress = 0;
  let elapsed = "00:00";
  let stage = "";
  let result = null;
  let errorMessage = "";

  let fileId = "";
  let unlistenProgress = null;

  settingsStore.subscribe((s) => {
    outputDir = s.outputDir || "";
  });

  onMount(() => {
    if (typeof platform.onDownloadProgress === "function") {
      unlistenProgress = platform.onDownloadProgress((payload) => {
        if (payload.file_id !== fileId) return;
        progress = payload.progress;
        elapsed = payload.elapsed;
        stage = payload.stage;
      });
    }
  });

  onDestroy(() => {
    if (typeof unlistenProgress === "function") unlistenProgress();
  });

  // Site detection — used for the chip and for switching the format default
  // (Spotify is always audio-only).
  const SITE_PATTERNS = [
    { match: /open\.spotify\.com|^spotify:/i, name: "Spotify", audioOnly: true },
    { match: /youtube\.com|youtu\.be/i, name: "YouTube" },
    { match: /(twitter\.com|x\.com)/i, name: "X / Twitter" },
    { match: /instagram\.com/i, name: "Instagram" },
    { match: /snapchat\.com/i, name: "Snapchat" },
    { match: /tiktok\.com/i, name: "TikTok" },
    { match: /reddit\.com/i, name: "Reddit" },
    { match: /vimeo\.com/i, name: "Vimeo" },
    { match: /facebook\.com|fb\.watch/i, name: "Facebook" },
    { match: /soundcloud\.com/i, name: "SoundCloud", audioOnly: true },
    { match: /twitch\.tv/i, name: "Twitch" },
  ];

  $: detectedHit = url.trim() ? SITE_PATTERNS.find((p) => p.match.test(url)) : null;
  $: detectedSite = !url.trim() ? "" : (detectedHit?.name || "Unknown source");
  $: isSpotify = detectedHit?.name === "Spotify";
  $: audioForced = !!detectedHit?.audioOnly;
  $: if (audioForced && format !== "mp3") format = "mp3";

  $: isValidUrl = /^https?:\/\//i.test(url.trim()) || /^spotify:/i.test(url.trim());
  $: canDownload = isDesktop && isValidUrl && state === "idle";

  $: stageLabel = ({
    fetching: "Fetching info…",
    downloading: "Downloading…",
    merging: "Tagging & merging…",
    done: "Done",
  })[stage] || "Preparing…";

  async function pickOutputDir() {
    try {
      const dir = await platform.pickFolder?.();
      if (dir) {
        outputDir = dir;
        settingsStore.update((s) => ({ ...s, outputDir: dir }));
      }
    } catch (_) {}
  }

  async function handleDownload() {
    if (!canDownload) return;
    state = "downloading";
    downloadOp.set("downloading");
    progress = 0;
    elapsed = "00:00";
    stage = "fetching";
    errorMessage = "";
    result = null;
    fileId = crypto.randomUUID();

    try {
      const res = await platform.downloadFromUrl({
        fileId,
        url: url.trim(),
        format,
        quality,
        outputDir: outputDir || null,
      });
      result = res;
      state = "done";
      progress = 100;
      stage = "done";
      downloadOp.set("done");
    } catch (err) {
      errorMessage = `${err?.message || err}`;
      state = "error";
      downloadOp.set("idle");
    }
  }

  async function handleCancel() {
    try { await platform.cancelDownload?.(); } catch (_) {}
    state = "idle";
    progress = 0;
    stage = "";
    downloadOp.set("idle");
  }

  function handleReset() {
    state = "idle";
    progress = 0;
    stage = "";
    result = null;
    errorMessage = "";
    fileId = "";
    downloadOp.set("idle");
  }

  async function handleOpenFile() {
    if (result?.output_path) {
      try { await platform.openFile?.(result.output_path); } catch (_) {}
    }
  }

  async function handleOpenFolder() {
    if (result?.output_path) {
      try { await platform.openInFolder?.(result.output_path); } catch (_) {}
    }
  }

  function formatBytes(n) {
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
</script>

<div class="download-view">
  <div class="hero">
    <div class="icon">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </div>
    <h2>Download from URL</h2>
    <p class="sub">YouTube, Spotify, X, Instagram, TikTok, Snapchat, Reddit, Vimeo, Facebook, SoundCloud, Twitch — and 1800+ more sites.</p>
  </div>

  {#if state === "idle" || state === "error"}
    <div class="url-box">
      <input
        type="text"
        class="url-input"
        placeholder="https://… or spotify:track:…"
        bind:value={url}
        autocomplete="off"
        spellcheck="false"
      />
      {#if detectedSite}
        <span class="site-chip" class:unknown={detectedSite === "Unknown source"} class:spotify={isSpotify}>
          {detectedSite}
        </span>
      {/if}
    </div>

    <div class="options">
      <div class="field">
        <span class="field-label">Format</span>
        <div class="seg" role="group" aria-label="Format">
          <button class:active={format === "mp4"} on:click={() => (format = "mp4")} disabled={audioForced}>Video (MP4)</button>
          <button class:active={format === "mp3"} on:click={() => (format = "mp3")}>Audio (MP3)</button>
        </div>
        {#if audioForced}
          <span class="field-hint">{detectedSite} only supports audio downloads.</span>
        {/if}
      </div>

      {#if format === "mp4"}
        <div class="field">
          <span class="field-label">Quality</span>
          <div class="seg" role="group" aria-label="Quality">
            <button class:active={quality === "best"} on:click={() => (quality = "best")}>Best</button>
            <button class:active={quality === "1080"} on:click={() => (quality = "1080")}>1080p</button>
            <button class:active={quality === "720"} on:click={() => (quality = "720")}>720p</button>
            <button class:active={quality === "480"} on:click={() => (quality = "480")}>480p</button>
          </div>
        </div>
      {/if}

      {#if isDesktop}
        <div class="field">
          <span class="field-label">Save to</span>
          <div class="dir-row">
            <input
              type="text"
              class="dir-input"
              placeholder="Downloads folder"
              bind:value={outputDir}
              readonly
              on:click={pickOutputDir}
            />
            <button class="btn ghost small" on:click={pickOutputDir}>Choose…</button>
          </div>
        </div>
      {/if}
    </div>

    {#if state === "error"}
      <div class="error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{errorMessage}</span>
      </div>
    {/if}

    {#if isDesktop}
      <div class="actions">
        <button class="btn primary" disabled={!canDownload} on:click={handleDownload}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {isSpotify ? "Download from Spotify" : "Download"}
        </button>
      </div>
    {:else}
      <div class="web-notice">
        <DesktopDownload variant="card" />
        <p class="web-explainer">
          URL downloads need the desktop app — they require a local yt-dlp binary that can't run in a browser sandbox.
          The web version is great for converting and editing files you already have on disk.
        </p>
      </div>
    {/if}

  {:else if state === "downloading"}
    <div class="progress-panel">
      <div class="progress-top">
        <span class="stage-label">{stageLabel}</span>
        <span class="progress-num">{progress.toFixed(1)}% &middot; {elapsed}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width: {progress}%"></div>
      </div>
      <p class="progress-note">
        {#if detectedSite && detectedSite !== "Unknown source"}
          From {detectedSite}
        {:else}
          From {url.substring(0, 60)}{url.length > 60 ? "…" : ""}
        {/if}
      </p>
    </div>

    <div class="actions">
      <button class="btn ghost" on:click={handleCancel}>Cancel</button>
    </div>

  {:else if state === "done"}
    <div class="done-panel">
      <div class="done-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <div class="done-title">Download complete</div>
      <div class="done-file">{result?.title || "Saved"}</div>
      {#if result?.output_size}
        <div class="done-size">{formatBytes(result.output_size)}</div>
      {/if}
    </div>

    <div class="actions done-actions">
      <button class="btn ghost" on:click={handleOpenFolder}>Open folder</button>
      <button class="btn primary" on:click={handleOpenFile}>Open file</button>
    </div>
    <div class="actions">
      <button class="btn link" on:click={handleReset}>Download another</button>
    </div>
  {/if}
</div>

<style>
  .download-view {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-bottom: 20px;
    animation: fadeUp 0.35s ease-out;
    max-width: 560px;
    margin: 0 auto;
    width: 100%;
  }

  .hero {
    text-align: center;
    padding: 8px 0 4px;
  }

  .icon {
    width: 56px;
    height: 56px;
    border-radius: 14px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--accent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 10px;
  }

  h2 {
    font-size: 1.1rem;
    font-weight: 700;
    margin: 0 0 4px 0;
    letter-spacing: -0.02em;
  }

  .sub {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin: 0;
    line-height: 1.45;
  }

  .url-box {
    position: relative;
    display: flex;
  }

  .url-input {
    flex: 1;
    padding: 12px 88px 12px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.88rem;
    font-family: inherit;
    outline: none;
    transition: border-color var(--transition-fast);
  }
  .url-input:focus {
    border-color: var(--accent-dim);
    box-shadow: 0 0 0 3px var(--accent-glow, rgba(0, 0, 0, 0.05));
  }

  .site-chip {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    padding: 3px 9px;
    border-radius: 100px;
    background: var(--accent-dim, var(--bg-secondary));
    color: var(--accent);
    font-size: 0.68rem;
    font-weight: 600;
    pointer-events: none;
  }
  .site-chip.unknown {
    background: var(--bg-secondary);
    color: var(--text-muted);
  }
  .site-chip.spotify {
    background: rgba(30, 215, 96, 0.15);
    color: rgb(30, 215, 96);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field-label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .field-hint {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .seg {
    display: flex;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px;
    gap: 2px;
  }

  .seg button {
    flex: 1;
    padding: 7px 10px;
    border-radius: calc(var(--radius-sm) - 3px);
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-muted);
    background: transparent;
    transition: all var(--transition-fast);
  }
  .seg button:hover:not(:disabled):not(.active) {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }
  .seg button.active {
    background: var(--bg-card);
    color: var(--text-primary);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }
  .seg button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .dir-row {
    display: flex;
    gap: 6px;
  }

  .dir-input {
    flex: 1;
    padding: 8px 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.78rem;
    font-family: inherit;
    cursor: pointer;
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    padding: 4px 0 2px;
  }

  .actions.done-actions {
    padding-top: 8px;
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
    box-shadow: 0 0 18px var(--accent-glow), 0 4px 10px rgba(0, 0, 0, 0.25);
  }
  .btn.primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn.ghost {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .btn.ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
  .btn.ghost.small { padding: 7px 12px; font-size: 0.76rem; }

  .btn.link {
    background: transparent;
    color: var(--text-muted);
    padding: 6px 12px;
    font-size: 0.78rem;
    text-decoration: underline;
    text-decoration-color: var(--border);
    text-underline-offset: 3px;
  }
  .btn.link:hover { color: var(--accent); }

  .error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: var(--radius-sm);
    color: rgb(239, 68, 68);
    font-size: 0.78rem;
    line-height: 1.4;
  }
  .error svg { flex-shrink: 0; margin-top: 1px; }

  .web-notice {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .web-explainer {
    font-size: 0.74rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
    text-align: center;
  }

  .progress-panel {
    padding: 18px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .progress-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .stage-label {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .progress-num {
    font-size: 0.78rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .bar-track {
    width: 100%;
    height: 6px;
    background: var(--bg-secondary);
    border-radius: 3px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
    box-shadow: 0 0 8px var(--accent-glow, var(--accent));
  }

  .progress-note {
    font-size: 0.74rem;
    color: var(--text-muted);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .done-panel {
    text-align: center;
    padding: 20px 14px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .done-icon {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(34, 197, 94, 0.12);
    color: rgb(34, 197, 94);
    margin: 0 auto 10px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .done-title {
    font-size: 1rem;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .done-file {
    font-size: 0.85rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 8px;
  }
  .done-size {
    font-size: 0.74rem;
    color: var(--text-muted);
    margin-top: 4px;
  }
</style>
