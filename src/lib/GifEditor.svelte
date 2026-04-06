<script>
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy } from "svelte";

  export let duration = 0;
  export let trimStart = 0;
  export let trimEnd = 0;
  export let filePath = "";
  export let outputFormat = "";
  export let stripAudio = false;
  export let onUpdate;
  export let onStripAudioChange = () => {};

  $: isGif = outputFormat === "gif";
  $: showAudioToggle = !isGif;

  let trackEl;
  let videoEl;
  let dragging = null; // "start" | "end" | null
  let didDrag = false;
  let playing = false;
  let playheadTime = 0;
  let animFrame = null;
  let blobUrl = "";
  let loading = false;
  let loadedPath = "";

  $: maxDuration = duration || 0;
  $: startPct = maxDuration > 0 ? (trimStart / maxDuration) * 100 : 0;
  $: endPct = maxDuration > 0 ? (trimEnd / maxDuration) * 100 : 100;
  $: clipDuration = trimEnd - trimStart;
  $: playheadPct = maxDuration > 0 ? (playheadTime / maxDuration) * 100 : 0;

  // Load video via Rust command + blob URL
  $: if (filePath && filePath !== loadedPath) {
    loadVideo(filePath);
  }

  async function loadVideo(path) {
    loadedPath = path;
    loading = true;
    cleanupBlob();
    try {
      const buffer = await invoke("read_file_binary", { path });
      const ext = path.split(".").pop().toLowerCase();
      const mimeMap = {
        mp4: "video/mp4", webm: "video/webm", avi: "video/x-msvideo",
        mkv: "video/x-matroska", mov: "video/quicktime", m4v: "video/mp4",
        ts: "video/mp2t", flv: "video/x-flv", wmv: "video/x-ms-wmv",
      };
      const blob = new Blob([buffer], { type: mimeMap[ext] || "video/mp4" });
      blobUrl = URL.createObjectURL(blob);
    } catch (e) {
      console.error("Failed to load video preview:", e);
      blobUrl = "";
    }
    loading = false;
  }

  function cleanupBlob() {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      blobUrl = "";
    }
  }

  onDestroy(() => {
    cleanupBlob();
    if (animFrame) cancelAnimationFrame(animFrame);
  });

  // Seek video when trim handles move (only when not playing and not dragging)
  $: if (videoEl && !playing && !dragging) {
    videoEl.currentTime = trimStart;
    playheadTime = trimStart;
  }

  // Control muted via JS property (Svelte attribute doesn't toggle reliably)
  $: if (videoEl) {
    videoEl.muted = isGif || stripAudio;
  }

  function fmtTime(sec) {
    if (!sec && sec !== 0) return "0:00.0";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${m}:${String(s).padStart(2, "0")}.${ms}`;
  }

  function parseTime(str) {
    if (!str || !str.trim()) return null;
    const parts = str.trim().split(":");
    if (parts.length === 1) return parseFloat(parts[0]) || null;
    if (parts.length === 2) return (parseInt(parts[0]) || 0) * 60 + (parseFloat(parts[1]) || 0);
    return null;
  }

  function pctToTime(pct) {
    return Math.max(0, Math.min(maxDuration, (pct / 100) * maxDuration));
  }

  function getTrackPct(clientX) {
    if (!trackEl) return 0;
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  }

  function seekVideo(time) {
    if (videoEl) {
      videoEl.currentTime = time;
      playheadTime = time;
    }
  }

  function onHandleDown(handle, e) {
    e.preventDefault();
    e.stopPropagation();
    if (playing) stopPlayback();
    dragging = handle;
    didDrag = false;
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  }

  function onMouseMove(e) {
    if (!dragging) return;
    didDrag = true;
    const pct = getTrackPct(e.clientX);
    const time = pctToTime(pct);

    if (dragging === "start") {
      const clamped = Math.min(time, trimEnd - 0.1);
      const newStart = Math.max(0, clamped);
      onUpdate(newStart, trimEnd);
      seekVideo(newStart);
    } else {
      const clamped = Math.max(time, trimStart + 0.1);
      const newEnd = Math.min(maxDuration, clamped);
      onUpdate(trimStart, newEnd);
      seekVideo(newEnd);
    }
  }

  function onMouseUp() {
    dragging = null;
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    if (didDrag) {
      window.addEventListener("click", suppressClick, true);
      setTimeout(() => window.removeEventListener("click", suppressClick, true), 0);
    }
  }

  function suppressClick(e) {
    e.stopPropagation();
    e.preventDefault();
  }

  function onTrackClick(e) {
    if (dragging || didDrag) return;
    if (playing) stopPlayback();
    const pct = getTrackPct(e.clientX);
    const time = pctToTime(pct);
    const distStart = Math.abs(time - trimStart);
    const distEnd = Math.abs(time - trimEnd);
    if (distStart < distEnd) {
      const newStart = Math.max(0, Math.min(time, trimEnd - 0.1));
      onUpdate(newStart, trimEnd);
      seekVideo(newStart);
    } else {
      const newEnd = Math.min(maxDuration, Math.max(time, trimStart + 0.1));
      onUpdate(trimStart, newEnd);
      seekVideo(newEnd);
    }
  }

  function togglePlay() {
    if (playing) stopPlayback();
    else startPlayback();
  }

  function startPlayback() {
    if (!videoEl) return;
    videoEl.currentTime = trimStart;
    playheadTime = trimStart;
    videoEl.play();
    playing = true;
    tickPlayback();
  }

  function stopPlayback() {
    playing = false;
    if (videoEl) videoEl.pause();
    if (animFrame) {
      cancelAnimationFrame(animFrame);
      animFrame = null;
    }
  }

  function tickPlayback() {
    if (!playing || !videoEl) return;
    playheadTime = videoEl.currentTime;
    if (videoEl.currentTime >= trimEnd) {
      stopPlayback();
      videoEl.currentTime = trimStart;
      playheadTime = trimStart;
      return;
    }
    animFrame = requestAnimationFrame(tickPlayback);
  }

  function onVideoLoaded() {
    if (videoEl) {
      videoEl.currentTime = trimStart;
      playheadTime = trimStart;
    }
  }

  function onStartInput(e) {
    const val = parseTime(e.target.value);
    if (val !== null && val >= 0 && val < trimEnd - 0.1) {
      onUpdate(val, trimEnd);
      seekVideo(val);
    }
    e.target.value = fmtTime(trimStart);
  }

  function onEndInput(e) {
    const val = parseTime(e.target.value);
    if (val !== null && val > trimStart + 0.1 && val <= maxDuration) {
      onUpdate(trimStart, val);
      seekVideo(val);
    }
    e.target.value = fmtTime(trimEnd);
  }

  // Tick marks for the timeline
  $: ticks = (() => {
    if (maxDuration <= 0) return [];
    let interval;
    if (maxDuration <= 10) interval = 1;
    else if (maxDuration <= 30) interval = 5;
    else if (maxDuration <= 120) interval = 10;
    else if (maxDuration <= 300) interval = 30;
    else interval = 60;

    const result = [];
    for (let t = 0; t <= maxDuration; t += interval) {
      result.push({ time: t, pct: (t / maxDuration) * 100 });
    }
    if (result.length === 0 || result[result.length - 1].time < maxDuration) {
      result.push({ time: maxDuration, pct: 100 });
    }
    return result;
  })();
</script>

<div class="gif-editor">
  <div class="editor-header">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="1" y="4" width="22" height="16" rx="2" ry="2"/>
      <line x1="1" y1="10" x2="23" y2="10"/>
    </svg>
    <span class="title">Clip Editor</span>
    <span class="clip-duration">{fmtTime(clipDuration)}</span>
  </div>

  <!-- Video preview -->
  <div class="preview-container">
    {#if loading}
      <div class="loading-indicator">Loading preview...</div>
    {:else if blobUrl}
      <!-- svelte-ignore a11y-media-has-caption -->
      <video
        bind:this={videoEl}
        src={blobUrl}
        preload="auto"
        on:loadeddata={onVideoLoaded}
        class="video-preview"
      ></video>
      <button class="play-btn" on:click={togglePlay} title={playing ? "Pause" : "Play clip"}>
        {#if playing}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1"/>
            <rect x="14" y="4" width="4" height="16" rx="1"/>
          </svg>
        {:else}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6,4 20,12 6,20"/>
          </svg>
        {/if}
      </button>
      <div class="preview-time">{fmtTime(playheadTime)}</div>
    {:else}
      <div class="loading-indicator">No preview available</div>
    {/if}
  </div>

  <div class="timeline">
    <div class="tick-bar">
      {#each ticks as tick}
        <span class="tick" style="left: {tick.pct}%">
          <span class="tick-label">{fmtTime(tick.time)}</span>
        </span>
      {/each}
    </div>

    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div
      class="track"
      bind:this={trackEl}
      on:click={onTrackClick}
      role="slider"
      tabindex="0"
      aria-valuemin={0}
      aria-valuemax={maxDuration}
      aria-valuenow={trimStart}
    >
      <div class="dim-region left" style="width: {startPct}%"></div>
      <div class="dim-region right" style="width: {100 - endPct}%"></div>
      <div class="selection" style="left: {startPct}%; width: {endPct - startPct}%"></div>

      {#if blobUrl}
        <div class="playhead" style="left: {playheadPct}%"></div>
      {/if}

      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div
        class="handle start"
        class:active={dragging === "start"}
        style="left: {startPct}%"
        on:mousedown={(e) => onHandleDown("start", e)}
      >
        <div class="handle-grip">
          <div class="grip-line"></div>
          <div class="grip-line"></div>
          <div class="grip-line"></div>
        </div>
      </div>

      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div
        class="handle end"
        class:active={dragging === "end"}
        style="left: {endPct}%"
        on:mousedown={(e) => onHandleDown("end", e)}
      >
        <div class="handle-grip">
          <div class="grip-line"></div>
          <div class="grip-line"></div>
          <div class="grip-line"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="time-row">
    <div class="time-badge">
      <span class="time-label">Start</span>
      <input
        class="time-input"
        type="text"
        value={fmtTime(trimStart)}
        on:change={onStartInput}
        on:focus={(e) => e.target.select()}
      />
    </div>
    <div class="time-badge center">
      <span class="time-label">Duration</span>
      <span class="time-value accent">{fmtTime(clipDuration)}</span>
    </div>
    <div class="time-badge">
      <span class="time-label">End</span>
      <input
        class="time-input"
        type="text"
        value={fmtTime(trimEnd)}
        on:change={onEndInput}
        on:focus={(e) => e.target.select()}
      />
    </div>
  </div>

  {#if showAudioToggle}
    <label class="audio-toggle">
      <span class="toggle-track" class:active={stripAudio}>
        <span class="toggle-thumb"></span>
      </span>
      <!-- svelte-ignore a11y-click-events-have-key-events -->
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <span class="toggle-label" on:click={() => onStripAudioChange(!stripAudio)}>
        {stripAudio ? "Audio removed" : "Audio included"}
      </span>
      <input type="checkbox" checked={stripAudio} on:change={() => onStripAudioChange(!stripAudio)} hidden />
    </label>
  {/if}
</div>

<style>
  .gif-editor {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
    animation: fadeUp 0.3s ease-out;
  }

  .editor-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 14px;
    color: var(--text-secondary);
  }

  .editor-header svg { color: var(--accent); flex-shrink: 0; }

  .title {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .clip-duration {
    margin-left: auto;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  /* Video preview */
  .preview-container {
    position: relative;
    margin-bottom: 12px;
    border-radius: 6px;
    overflow: hidden;
    background: #000;
    aspect-ratio: 16 / 9;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-preview {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }

  .loading-indicator {
    color: var(--text-muted);
    font-size: 0.78rem;
    font-weight: 500;
  }

  .play-btn {
    position: absolute;
    bottom: 10px;
    left: 10px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s, transform 0.15s;
    padding: 0;
  }

  .play-btn:hover {
    background: rgba(0, 0, 0, 0.85);
    transform: scale(1.08);
  }

  .preview-time {
    position: absolute;
    bottom: 10px;
    right: 10px;
    font-size: 0.72rem;
    font-weight: 600;
    color: #fff;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(4px);
    padding: 4px 10px;
    border-radius: 4px;
    font-variant-numeric: tabular-nums;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .timeline { margin-bottom: 12px; }

  .tick-bar {
    position: relative;
    height: 16px;
    margin-bottom: 4px;
  }

  .tick {
    position: absolute;
    transform: translateX(-50%);
  }

  .tick::before {
    content: "";
    display: block;
    width: 1px;
    height: 4px;
    background: var(--text-muted);
    margin: 0 auto 2px;
  }

  .tick-label {
    font-size: 0.6rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .track {
    position: relative;
    height: 36px;
    background: var(--bg-secondary);
    border-radius: 4px;
    border: 1px solid var(--border);
    cursor: pointer;
    overflow: visible;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }

  .dim-region {
    position: absolute;
    top: 0;
    height: 100%;
    background: var(--bg-primary);
    opacity: 0.6;
    pointer-events: none;
    z-index: 1;
  }

  .dim-region.left { left: 0; border-radius: 3px 0 0 3px; }
  .dim-region.right { right: 0; border-radius: 0 3px 3px 0; }

  .selection {
    position: absolute;
    top: 0;
    height: 100%;
    background: var(--accent-subtle);
    border-top: 2px solid var(--accent);
    border-bottom: 2px solid var(--accent);
    pointer-events: none;
    z-index: 1;
  }

  .playhead {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 2px;
    background: #fff;
    transform: translateX(-50%);
    z-index: 4;
    pointer-events: none;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.5);
    border-radius: 1px;
  }

  .handle {
    position: absolute;
    top: -6px;
    bottom: -6px;
    width: 24px;
    transform: translateX(-50%);
    z-index: 3;
    cursor: ew-resize;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .handle-grip {
    width: 12px;
    height: 28px;
    background: var(--accent);
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    box-shadow: 0 0 8px var(--accent-glow);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
  }

  .handle:hover .handle-grip,
  .handle.active .handle-grip {
    transform: scaleY(1.1) scaleX(1.15);
    box-shadow: 0 0 20px var(--accent-glow);
    background: var(--accent-hover);
  }

  .grip-line {
    width: 6px;
    height: 1px;
    background: var(--btn-primary-text);
    border-radius: 1px;
    opacity: 0.7;
  }

  .time-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .time-badge {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
  }

  .time-badge.center { flex: 1; }

  .time-label {
    font-size: 0.6rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }

  .time-input {
    width: 72px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    text-align: center;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 4px 6px;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }

  .time-input:hover { border-color: var(--border-hover); }
  .time-input:focus { border-color: var(--accent); }

  .time-value {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .time-value.accent {
    color: var(--accent);
  }

  /* Audio toggle */
  .audio-toggle {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    cursor: pointer;
    -webkit-user-select: none;
    user-select: none;
  }

  .toggle-track {
    width: 34px;
    height: 18px;
    border-radius: 9px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    position: relative;
    transition: background 0.2s, border-color 0.2s;
    flex-shrink: 0;
  }

  .toggle-track.active {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-muted);
    transition: transform 0.2s, background 0.2s;
  }

  .toggle-track.active .toggle-thumb {
    transform: translateX(16px);
    background: var(--btn-primary-text);
  }

  .toggle-label {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
  }
</style>
