<script>
  export let duration = 0;
  export let trimStart = 0;
  export let trimEnd = 0;
  export let onUpdate;

  let trackEl;
  let dragging = null; // "start" | "end" | null
  let didDrag = false;

  $: maxDuration = duration || 0;
  $: startPct = maxDuration > 0 ? (trimStart / maxDuration) * 100 : 0;
  $: endPct = maxDuration > 0 ? (trimEnd / maxDuration) * 100 : 100;
  $: clipDuration = trimEnd - trimStart;

  function fmtTime(sec) {
    if (!sec && sec !== 0) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 10);
    return `${m}:${String(s).padStart(2, "0")}.${ms}`;
  }

  function pctToTime(pct) {
    return Math.max(0, Math.min(maxDuration, (pct / 100) * maxDuration));
  }

  function getTrackPct(clientX) {
    if (!trackEl) return 0;
    const rect = trackEl.getBoundingClientRect();
    return Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
  }

  function onHandleDown(handle, e) {
    e.preventDefault();
    e.stopPropagation();
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
      onUpdate(Math.max(0, clamped), trimEnd);
    } else {
      const clamped = Math.max(time, trimStart + 0.1);
      onUpdate(trimStart, Math.min(maxDuration, clamped));
    }
  }

  function onMouseUp() {
    dragging = null;
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
    // Suppress the click that fires after mouseup
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
    const pct = getTrackPct(e.clientX);
    const time = pctToTime(pct);
    // Snap nearest handle
    const distStart = Math.abs(time - trimStart);
    const distEnd = Math.abs(time - trimEnd);
    if (distStart < distEnd) {
      onUpdate(Math.max(0, Math.min(time, trimEnd - 0.1)), trimEnd);
    } else {
      onUpdate(trimStart, Math.min(maxDuration, Math.max(time, trimStart + 0.1)));
    }
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
    <span class="title">GIF Clip Editor</span>
    <span class="clip-duration">{fmtTime(clipDuration)}</span>
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
      <!-- Dimmed regions outside selection -->
      <div class="dim-region left" style="width: {startPct}%"></div>
      <div class="dim-region right" style="width: {100 - endPct}%"></div>

      <!-- Selected region -->
      <div class="selection" style="left: {startPct}%; width: {endPct - startPct}%"></div>

      <!-- Start handle -->
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

      <!-- End handle -->
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
      <span class="time-value">{fmtTime(trimStart)}</span>
    </div>
    <div class="time-badge center">
      <span class="time-label">Duration</span>
      <span class="time-value accent">{fmtTime(clipDuration)}</span>
    </div>
    <div class="time-badge">
      <span class="time-label">End</span>
      <span class="time-value">{fmtTime(trimEnd)}</span>
    </div>
  </div>
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

  .time-value {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .time-value.accent {
    color: var(--accent);
  }
</style>
