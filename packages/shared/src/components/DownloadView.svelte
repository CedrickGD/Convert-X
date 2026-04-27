<script>
  import { onMount, onDestroy } from "svelte";
  import { getPlatform } from "../platform.js";
  import { settingsStore, downloadOp } from "../stores/fileStore.js";
  import DesktopDownload from "./DesktopDownload.svelte";

  const platform = getPlatform();
  const isDesktop = platform.platformType === "desktop";

  const VIDEO_FORMATS = ["mp4", "mkv", "webm", "avi", "mov"];
  const AUDIO_FORMATS = ["mp3", "m4a", "wav", "flac", "ogg", "opus"];

  let url = "";
  let detectedSite = "";
  let category = "video";       // "video" | "audio"
  let format = "mp4";           // any value from VIDEO_FORMATS or AUDIO_FORMATS
  let quality = "best";
  let outputDir = "";

  // States: idle | probing | preview | downloading | done | error
  let state = "idle";
  let progress = 0;
  let elapsed = "00:00";
  let stage = "";
  let errorMessage = "";

  let probe = null;            // ProbeResult from backend
  let selected = new Set();    // entry indexes (1-based) selected for download
  let currentItemTitle = "";
  let currentItemIndex = 0;
  let totalItems = 0;
  let results = [];            // array of DownloadResult for "done" state

  let fileId = "";
  let unlistenProgress = null;

  settingsStore.subscribe((s) => {
    outputDir = s.outputDir || "";
  });

  onMount(() => {
    if (typeof platform.onDownloadProgress === "function") {
      unlistenProgress = platform.onDownloadProgress((payload) => {
        // Match either the bare fileId (single) or the per-item suffixed ID.
        if (!fileId) return;
        if (payload.file_id !== fileId && !payload.file_id?.startsWith(`${fileId}_`)) return;
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
    { match: /pornhub\.com|phncdn\.com/i, name: "Pornhub" },
    { match: /xvideos\.com/i, name: "XVideos" },
    { match: /xhamster\.com/i, name: "xHamster" },
    { match: /redgifs\.com/i, name: "RedGIFs" },
    { match: /streamable\.com/i, name: "Streamable" },
    { match: /dailymotion\.com/i, name: "Dailymotion" },
    { match: /bilibili\.com/i, name: "Bilibili" },
    { match: /(cdn\.discordapp\.com|media\.discordapp\.net)/i, name: "Discord CDN" },
  ];

  $: detectedHit = url.trim() ? SITE_PATTERNS.find((p) => p.match.test(url)) : null;
  $: detectedSite = !url.trim() ? "" : (detectedHit?.name || "Unknown source");
  $: isSpotify = detectedHit?.name === "Spotify";
  $: audioForced = !!detectedHit?.audioOnly;
  $: if (audioForced && format !== "mp3") format = "mp3";

  $: isValidUrl = /^https?:\/\//i.test(url.trim()) || /^spotify:/i.test(url.trim());
  $: canPreview = isDesktop && isValidUrl && state === "idle";

  // Preview-derived flags
  $: entries = probe?.entries || [];
  $: allImages = entries.length > 0 && entries.every((e) => e.kind === "image");
  $: anyImages = entries.some((e) => e.kind === "image");
  $: allAudio = entries.length > 0 && entries.every((e) => e.kind === "audio");
  $: isMulti = probe?.kind === "multi";
  $: selectedCount = selected.size;
  $: selectedEntries = entries.filter((e) => selected.has(e.index));

  // Force format for image-only previews; force audio category for Spotify/SoundCloud.
  $: if (allImages && format !== "image") format = "image";
  $: if (!allImages && format === "image") format = category === "audio" ? "mp3" : "mp4";
  $: if (audioForced && category !== "audio") category = "audio";
  // Keep `format` in sync with the chosen category.
  $: if (category === "video" && !VIDEO_FORMATS.includes(format)) format = "mp4";
  $: if (category === "audio" && !AUDIO_FORMATS.includes(format)) format = "mp3";

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

  async function handlePreview() {
    if (!canPreview) return;
    state = "probing";
    errorMessage = "";
    probe = null;
    selected = new Set();
    results = [];

    try {
      const res = await platform.probeUrl(url.trim());
      probe = res;
      // Default: select all entries.
      selected = new Set((res.entries || []).map((e) => e.index));
      state = "preview";
    } catch (err) {
      errorMessage = `${err?.message || err}`;
      state = "error";
    }
  }

  function backToIdle() {
    state = "idle";
    probe = null;
    selected = new Set();
    progress = 0;
    stage = "";
    errorMessage = "";
    fileId = "";
    results = [];
    downloadOp.set("idle");
  }

  function toggleEntry(idx) {
    const next = new Set(selected);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    selected = next;
  }

  function selectAll() {
    selected = new Set(entries.map((e) => e.index));
  }

  function clearSelection() {
    selected = new Set();
  }

  function formatDuration(secs) {
    if (!secs || !isFinite(secs)) return "";
    const s = Math.round(secs);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function entryFormat(entry) {
    if (entry.kind === "image") return "image";
    // Audio-only sources can't produce a video container — fall back to mp3 if
    // the user picked a video format.
    if (entry.kind === "audio" && VIDEO_FORMATS.includes(format)) return "mp3";
    return format;
  }

  async function handleDownload() {
    if (state !== "preview" || selectedCount === 0) return;

    state = "downloading";
    downloadOp.set("downloading");
    errorMessage = "";
    results = [];
    progress = 0;
    elapsed = "00:00";
    stage = "fetching";

    const baseId = crypto.randomUUID();
    fileId = baseId;
    const items = [...selectedEntries];
    totalItems = items.length;

    try {
      if (!isMulti) {
        // Single item: no playlist_items pin.
        const only = items[0] || { index: 1, title: probe?.title || "", kind: "video" };
        currentItemTitle = only.title || probe?.title || "";
        currentItemIndex = 1;
        progress = 0;
        stage = "fetching";
        const res = await platform.downloadFromUrl({
          fileId: baseId,
          url: url.trim(),
          format: entryFormat(only),
          quality,
          outputDir: outputDir || null,
        });
        results = [res];
      } else {
        // Multi-item: download each entry sequentially with --playlist-items pinning.
        for (let i = 0; i < items.length; i += 1) {
          const entry = items[i];
          currentItemTitle = entry.title;
          currentItemIndex = i + 1;
          progress = 0;
          stage = "fetching";
          const perItemId = `${baseId}_${entry.index}`;
          fileId = perItemId;
          const res = await platform.downloadFromUrl({
            fileId: perItemId,
            url: url.trim(),
            format: entryFormat(entry),
            quality,
            outputDir: outputDir || null,
            playlistItems: String(entry.index),
          });
          results = [...results, res];
        }
        // Restore base id so any trailing progress events are still matched.
        fileId = baseId;
      }
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
    state = probe ? "preview" : "idle";
    progress = 0;
    stage = "";
    downloadOp.set("idle");
  }

  function handleReset() {
    backToIdle();
  }

  async function handleOpenFile(path) {
    if (path) {
      try { await platform.openFile?.(path); } catch (_) {}
    }
  }

  async function handleOpenFolder(path) {
    if (path) {
      try { await platform.openInFolder?.(path); } catch (_) {}
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

    {#if isDesktop}
      <div class="options compact">
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
      </div>
    {/if}

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
        <button class="btn primary" disabled={!canPreview} on:click={handlePreview}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Preview
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

  {:else if state === "probing"}
    <div class="progress-panel">
      <div class="progress-top">
        <span class="stage-label">Fetching info…</span>
        <span class="progress-num">{detectedSite || ""}</span>
      </div>
      <div class="bar-track indeterminate">
        <div class="bar-fill bar-pulse"></div>
      </div>
      <p class="progress-note">Reading the URL — usually 1–5 seconds.</p>
    </div>

  {:else if state === "preview"}
    <div class="preview-header">
      <button class="btn link" on:click={backToIdle}>← Edit URL</button>
      {#if probe?.uploader}
        <span class="uploader">{probe.uploader}</span>
      {/if}
    </div>

    {#if !isMulti}
      <!-- Single item card -->
      <div class="single-card">
        {#if entries[0]?.thumbnail || probe?.thumbnail}
          <div class="single-thumb">
            <img src={entries[0]?.thumbnail || probe?.thumbnail} alt="" referrerpolicy="no-referrer" />
            {#if entries[0]?.kind === "image"}
              <span class="kind-chip image">Image</span>
            {:else if entries[0]?.kind === "audio"}
              <span class="kind-chip audio">Audio</span>
            {:else if entries[0]?.duration}
              <span class="duration-chip">{formatDuration(entries[0].duration)}</span>
            {/if}
          </div>
        {/if}
        <div class="single-meta">
          <div class="single-title">{probe?.title || entries[0]?.title || "Untitled"}</div>
          {#if probe?.uploader}
            <div class="single-sub">{probe.uploader}</div>
          {/if}
        </div>
      </div>
    {:else}
      <!-- Multi-item grid -->
      <div class="multi-toolbar">
        <div class="multi-title">
          <strong>{probe?.title || "Multi-item post"}</strong>
          <span class="multi-count">{entries.length} items · {selectedCount} selected</span>
        </div>
        <div class="multi-actions">
          <button class="btn ghost small" on:click={selectAll} disabled={selectedCount === entries.length}>Select all</button>
          <button class="btn ghost small" on:click={clearSelection} disabled={selectedCount === 0}>Clear</button>
        </div>
      </div>
      <div class="grid">
        {#each entries as entry (entry.index)}
          <button
            type="button"
            class="grid-card"
            class:selected={selected.has(entry.index)}
            on:click={() => toggleEntry(entry.index)}
          >
            <div class="grid-thumb">
              {#if entry.thumbnail}
                <img src={entry.thumbnail} alt="" referrerpolicy="no-referrer" />
              {:else}
                <div class="thumb-placeholder">
                  {entry.kind === "image" ? "IMG" : entry.kind === "audio" ? "AUD" : "VID"}
                </div>
              {/if}
              <span class="check" class:on={selected.has(entry.index)}>
                {#if selected.has(entry.index)}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                {/if}
              </span>
              {#if entry.kind === "image"}
                <span class="kind-chip image small">Image</span>
              {:else if entry.kind === "audio"}
                <span class="kind-chip audio small">Audio</span>
              {:else if entry.duration}
                <span class="duration-chip small">{formatDuration(entry.duration)}</span>
              {/if}
            </div>
            <div class="grid-title">{entry.title}</div>
          </button>
        {/each}
      </div>
    {/if}

    <div class="options">
      {#if !allImages}
        <div class="field">
          <span class="field-label">Type</span>
          <div class="seg" role="group" aria-label="Type">
            <button class:active={category === "video"} on:click={() => (category = "video")} disabled={audioForced}>Video</button>
            <button class:active={category === "audio"} on:click={() => (category = "audio")}>Audio</button>
          </div>
          {#if audioForced}
            <span class="field-hint">{detectedSite} only supports audio downloads.</span>
          {:else if anyImages}
            <span class="field-hint">Images are downloaded as-is (jpg/png/webp).</span>
          {/if}
        </div>

        <div class="field">
          <span class="field-label">Format</span>
          <select class="select" bind:value={format} aria-label="Output format">
            {#each (category === "video" ? VIDEO_FORMATS : AUDIO_FORMATS) as f}
              <option value={f}>{f.toUpperCase()}</option>
            {/each}
          </select>
        </div>

        {#if category === "video"}
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
      {:else}
        <div class="field">
          <span class="field-hint">Images downloaded in their original format (.jpg / .png / .webp).</span>
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

    <div class="actions">
      <button class="btn primary" disabled={selectedCount === 0} on:click={handleDownload}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {#if isMulti}
          Download {selectedCount} {selectedCount === 1 ? "item" : "items"}
        {:else if isSpotify}
          Download from Spotify
        {:else}
          Download
        {/if}
      </button>
    </div>

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
        {#if totalItems > 1}
          Item {currentItemIndex} of {totalItems} — {currentItemTitle || "…"}
        {:else if currentItemTitle}
          {currentItemTitle}
        {:else if detectedSite && detectedSite !== "Unknown source"}
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
      <div class="done-title">
        {#if results.length > 1}
          Downloaded {results.length} items
        {:else}
          Download complete
        {/if}
      </div>

      {#if results.length === 1}
        <div class="done-file">{results[0]?.title || "Saved"}</div>
        {#if results[0]?.output_size}
          <div class="done-size">{formatBytes(results[0].output_size)}</div>
        {/if}
      {:else}
        <ul class="done-list">
          {#each results as r}
            <li class="done-item">
              <div class="done-item-meta">
                <div class="done-item-title">{r.title || "Saved"}</div>
                {#if r.output_size}
                  <div class="done-item-size">{formatBytes(r.output_size)}</div>
                {/if}
              </div>
              <div class="done-item-actions">
                <button class="btn ghost small" on:click={() => handleOpenFolder(r.output_path)}>Folder</button>
                <button class="btn ghost small" on:click={() => handleOpenFile(r.output_path)}>Open</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    {#if results.length === 1}
      <div class="actions done-actions">
        <button class="btn ghost" on:click={() => handleOpenFolder(results[0]?.output_path)}>Open folder</button>
        <button class="btn primary" on:click={() => handleOpenFile(results[0]?.output_path)}>Open file</button>
      </div>
    {/if}
    <div class="actions">
      <button class="btn link" on:click={handleReset}>Download another</button>
    </div>
  {/if}
</div>

<style>
  .download-view { display: flex; flex-direction: column; gap: 14px; padding-bottom: 20px; animation: fadeUp 0.35s ease-out; max-width: 620px; margin: 0 auto; width: 100%; }
  .hero { text-align: center; padding: 8px 0 4px; }
  .icon { width: 56px; height: 56px; border-radius: 14px; background: var(--bg-card); border: 1px solid var(--border); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; margin-bottom: 10px; }
  h2 { font-size: 1.1rem; font-weight: 700; margin: 0 0 4px 0; letter-spacing: -0.02em; }
  .sub { font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.45; }

  .url-box { position: relative; display: flex; }
  .url-input { flex: 1; padding: 12px 88px 12px 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.88rem; font-family: inherit; outline: none; transition: border-color var(--transition-fast); }
  .url-input:focus { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-glow, rgba(0,0,0,0.05)); }

  .site-chip { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); padding: 3px 9px; border-radius: 100px; background: var(--accent-dim, var(--bg-secondary)); color: var(--accent); font-size: 0.68rem; font-weight: 600; pointer-events: none; }
  .site-chip.unknown { background: var(--bg-secondary); color: var(--text-muted); }
  .site-chip.spotify { background: rgba(30,215,96,0.15); color: rgb(30,215,96); }

  .options { display: flex; flex-direction: column; gap: 12px; padding: 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .options.compact { padding: 12px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
  .field-hint { font-size: 0.7rem; color: var(--text-muted); }

  .seg { display: flex; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 3px; gap: 2px; }
  .seg button { flex: 1; padding: 7px 10px; border-radius: calc(var(--radius-sm) - 3px); font-size: 0.78rem; font-weight: 600; color: var(--text-muted); background: transparent; transition: all var(--transition-fast); }
  .seg button:hover:not(:disabled):not(.active) { color: var(--text-secondary); background: var(--bg-hover); }
  .seg button.active { background: var(--bg-card); color: var(--text-primary); box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
  .seg button:disabled { opacity: 0.4; cursor: not-allowed; }

  .dir-row { display: flex; gap: 6px; }
  .dir-input { flex: 1; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.78rem; font-family: inherit; cursor: pointer; }
  .select { padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.82rem; font-family: inherit; font-weight: 600; outline: none; cursor: pointer; }
  .select:hover { border-color: var(--accent-dim); }
  .select:focus { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-glow, rgba(0,0,0,0.05)); }

  .actions { display: flex; gap: 10px; justify-content: center; padding: 4px 0 2px; flex-wrap: wrap; }
  .actions.done-actions { padding-top: 8px; }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 24px; border-radius: var(--radius-sm); font-weight: 600; font-size: 0.85rem; letter-spacing: -0.01em; }
  .btn.primary { background: var(--accent); color: var(--btn-primary-text); padding: 11px 32px; }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); box-shadow: 0 0 18px var(--accent-glow), 0 4px 10px rgba(0,0,0,0.25); }
  .btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.ghost { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); }
  .btn.ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  .btn.ghost.small { padding: 7px 12px; font-size: 0.76rem; }
  .btn.ghost:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.link { background: transparent; color: var(--text-muted); padding: 6px 12px; font-size: 0.78rem; text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
  .btn.link:hover { color: var(--accent); }

  .error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); border-radius: var(--radius-sm); color: rgb(239,68,68); font-size: 0.78rem; line-height: 1.4; }
  .error svg { flex-shrink: 0; margin-top: 1px; }

  .web-notice { display: flex; flex-direction: column; gap: 10px; }
  .web-explainer { font-size: 0.74rem; color: var(--text-muted); line-height: 1.5; margin: 0; text-align: center; }

  .progress-panel { padding: 18px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 10px; }
  .progress-top { display: flex; justify-content: space-between; align-items: baseline; }
  .stage-label { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
  .progress-num { font-size: 0.78rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .bar-track { width: 100%; height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden; position: relative; }
  .bar-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; box-shadow: 0 0 8px var(--accent-glow, var(--accent)); }
  .bar-track.indeterminate .bar-pulse { width: 30%; animation: probePulse 1.2s ease-in-out infinite; }
  @keyframes probePulse { 0% { transform: translateX(-100%); } 50% { transform: translateX(150%); } 100% { transform: translateX(350%); } }
  .progress-note { font-size: 0.74rem; color: var(--text-muted); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .done-panel { text-align: center; padding: 20px 14px 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .done-icon { width: 48px; height: 48px; border-radius: 50%; background: rgba(34,197,94,0.12); color: rgb(34,197,94); margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; }
  .done-title { font-size: 1rem; font-weight: 700; margin-bottom: 4px; }
  .done-file { font-size: 0.85rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px; }
  .done-size { font-size: 0.74rem; color: var(--text-muted); margin-top: 4px; }
  .done-list { list-style: none; margin: 12px 0 0; padding: 0; text-align: left; display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
  .done-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .done-item-meta { min-width: 0; flex: 1; }
  .done-item-title { font-size: 0.8rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .done-item-size { font-size: 0.7rem; color: var(--text-muted); margin-top: 2px; }
  .done-item-actions { display: flex; gap: 6px; flex-shrink: 0; }

  /* Preview view */
  .preview-header { display: flex; align-items: center; justify-content: space-between; padding: 0 4px; }
  .uploader { font-size: 0.74rem; color: var(--text-muted); }

  .single-card { display: flex; gap: 14px; padding: 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); align-items: center; }
  .single-thumb { position: relative; width: 140px; height: 90px; flex-shrink: 0; border-radius: calc(var(--radius-sm) - 2px); overflow: hidden; background: var(--bg-secondary); }
  .single-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .single-meta { min-width: 0; flex: 1; }
  .single-title { font-size: 0.92rem; font-weight: 700; line-height: 1.3; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .single-sub { font-size: 0.74rem; color: var(--text-muted); margin-top: 4px; }

  .multi-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .multi-title { display: flex; flex-direction: column; min-width: 0; }
  .multi-title strong { font-size: 0.86rem; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .multi-count { font-size: 0.7rem; color: var(--text-muted); margin-top: 2px; }
  .multi-actions { display: flex; gap: 6px; flex-shrink: 0; }

  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  @media (max-width: 540px) { .grid { grid-template-columns: repeat(2, 1fr); } }
  .grid-card { display: flex; flex-direction: column; gap: 6px; padding: 6px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; text-align: left; transition: border-color var(--transition-fast), box-shadow var(--transition-fast); }
  .grid-card:hover { border-color: var(--accent-dim, var(--border)); }
  .grid-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .grid-thumb { position: relative; width: 100%; aspect-ratio: 1 / 1; border-radius: calc(var(--radius-sm) - 2px); overflow: hidden; background: var(--bg-secondary); }
  .grid-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700; color: var(--text-muted); letter-spacing: 0.08em; }
  .check { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.55); color: white; display: flex; align-items: center; justify-content: center; }
  .check.on { background: var(--accent); border-color: var(--accent); }
  .grid-title { font-size: 0.74rem; color: var(--text-secondary); line-height: 1.3; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  .duration-chip, .kind-chip { position: absolute; bottom: 6px; right: 6px; padding: 2px 6px; border-radius: 4px; background: rgba(0,0,0,0.65); color: white; font-size: 0.68rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .duration-chip.small, .kind-chip.small { font-size: 0.62rem; padding: 1px 5px; }
  .kind-chip.image { background: rgba(168,85,247,0.85); }
  .kind-chip.audio { background: rgba(30,215,96,0.85); }
</style>
