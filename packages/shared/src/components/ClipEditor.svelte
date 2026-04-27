<script>
  import { getPlatform } from "../platform.js";
  import { onDestroy } from "svelte";

  export let duration = 0;
  export let trimStart = 0;
  export let trimEnd = 0;
  export let filePath = "";
  export let fileObj = null;
  export let outputFormat = "";
  export let stripAudio = false;
  export let crop = null;
  export let rotate = 0;
  export let flipH = false;
  export let flipV = false;
  export let speed = 1;
  export let volume = 100;
  export let onUpdate;
  export let onStripAudioChange = () => {};
  export let onCropChange = () => {};
  export let onRotateChange = () => {};
  export let onFlipHChange = () => {};
  export let onFlipVChange = () => {};
  export let onSpeedChange = () => {};
  export let onVolumeChange = () => {};

  $: isGif = outputFormat === "gif";
  $: showAudioToggle = !isGif;
  $: showVideoEdits = !isGif;

  let trackEl;
  let videoEl;
  let dragging = null;
  let didDrag = false;
  let playing = false;
  let playheadTime = 0;
  let animFrame = null;
  let blobUrl = "";
  let loading = false;
  let loadedRef = "";

  // Source dimensions (from videoWidth/videoHeight)
  let srcW = 0;
  let srcH = 0;

  // Sub-section open state — auto-open if non-default value
  let cropOpen = !!crop;
  let transformOpen = rotate !== 0 || flipH || flipV;
  let speedOpen = speed !== 1;

  $: if (crop && !cropOpen) cropOpen = true;
  $: if ((rotate !== 0 || flipH || flipV) && !transformOpen) transformOpen = true;
  $: if (speed !== 1 && !speedOpen) speedOpen = true;

  // Crop state
  let aspectMode = "free"; // "free" | "1:1" | "16:9" | "9:16"
  let cropDrag = null; // { mode: "create" | "move" | "resize-<dir>", startX, startY, startRect }
  let overlayEl;

  $: maxDuration = duration || 0;
  $: startPct = maxDuration > 0 ? (trimStart / maxDuration) * 100 : 0;
  $: endPct = maxDuration > 0 ? (trimEnd / maxDuration) * 100 : 100;
  $: clipDuration = trimEnd - trimStart;
  $: playheadPct = maxDuration > 0 ? (playheadTime / maxDuration) * 100 : 0;

  $: fileRef = filePath || (fileObj ? fileObj.name : "");
  $: if (fileRef && fileRef !== loadedRef) {
    loadVideo(fileRef);
  }

  async function loadVideo(ref) {
    loadedRef = ref;
    loading = true;
    cleanupBlob();
    try {
      if (fileObj) {
        blobUrl = URL.createObjectURL(fileObj);
      } else {
        const buffer = await getPlatform().readFileBinary(filePath);
        const ext = filePath.split(".").pop().toLowerCase();
        const mimeMap = {
          mp4: "video/mp4", webm: "video/webm", avi: "video/x-msvideo",
          mkv: "video/x-matroska", mov: "video/quicktime", m4v: "video/mp4",
          ts: "video/mp2t", flv: "video/x-flv", wmv: "video/x-ms-wmv",
        };
        const blob = new Blob([buffer], { type: mimeMap[ext] || "video/mp4" });
        blobUrl = URL.createObjectURL(blob);
      }
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
    window.removeEventListener("mousemove", onCropMove, true);
    window.removeEventListener("mouseup", onCropUp, true);
    if (audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
      gainNode = null;
      srcNode = null;
      webAudioEnabled = false;
    }
  });

  $: if (videoEl && !playing && !dragging) {
    videoEl.currentTime = trimStart;
    playheadTime = trimStart;
  }

  $: if (videoEl) {
    videoEl.muted = isGif || stripAudio;
  }

  $: if (videoEl) {
    videoEl.playbackRate = Math.max(0.1, Math.min(10, speed || 1));
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
    } else if (dragging === "end") {
      const clamped = Math.max(time, trimStart + 0.1);
      const newEnd = Math.min(maxDuration, clamped);
      onUpdate(trimStart, newEnd);
      seekVideo(newEnd);
    } else if (dragging === "playhead") {
      seekVideo(Math.max(trimStart, Math.min(trimEnd, time)));
    }
  }

  function onPlayheadDown(e) {
    e.preventDefault();
    e.stopPropagation();
    if (playing) stopPlayback();
    dragging = "playhead";
    didDrag = false;
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
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
    seekVideo(Math.max(trimStart, Math.min(trimEnd, time)));
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
      srcW = videoEl.videoWidth || 0;
      srcH = videoEl.videoHeight || 0;
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

  // ── Crop overlay ──

  // Compute the displayed video rect inside the overlay (object-fit: contain)
  function getDisplayRect() {
    if (!videoEl || !srcW || !srcH) return null;
    const cs = videoEl.getBoundingClientRect();
    const cw = cs.width;
    const ch = cs.height;
    if (cw <= 0 || ch <= 0) return null;
    const srcAspect = srcW / srcH;
    const dispAspect = cw / ch;
    let w, h, x, y;
    if (srcAspect > dispAspect) {
      w = cw;
      h = cw / srcAspect;
      x = 0;
      y = (ch - h) / 2;
    } else {
      h = ch;
      w = ch * srcAspect;
      y = 0;
      x = (cw - w) / 2;
    }
    return { x, y, w, h };
  }

  // Convert source-pixel crop -> CSS overlay rect
  $: overlayRect = (() => {
    const disp = (typeof window !== "undefined") ? getDisplayRect() : null;
    if (!disp || !crop || !srcW || !srcH) return null;
    const sx = disp.w / srcW;
    const sy = disp.h / srcH;
    return {
      x: disp.x + crop.x * sx,
      y: disp.y + crop.y * sy,
      w: crop.w * sx,
      h: crop.h * sy,
    };
  })();

  function getAspectRatio() {
    if (aspectMode === "1:1") return 1;
    if (aspectMode === "16:9") return 16 / 9;
    if (aspectMode === "9:16") return 9 / 16;
    return null;
  }

  function clampCropToSource(rect) {
    let { x, y, w, h } = rect;
    x = Math.max(0, Math.min(srcW - 1, x));
    y = Math.max(0, Math.min(srcH - 1, y));
    w = Math.max(1, Math.min(srcW - x, w));
    h = Math.max(1, Math.min(srcH - y, h));
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    };
  }

  function applyAspect(w, h, ratio, anchor) {
    if (!ratio) return { w, h };
    // anchor decides which axis to preserve
    if (anchor === "w") return { w, h: w / ratio };
    if (anchor === "h") return { w: h * ratio, h };
    // pick the larger of the two
    if (w / h > ratio) return { w: h * ratio, h };
    return { w, h: w / ratio };
  }

  function overlayPointToSource(clientX, clientY) {
    const disp = getDisplayRect();
    if (!disp || !overlayEl) return null;
    const orect = overlayEl.getBoundingClientRect();
    const localX = clientX - orect.left - disp.x;
    const localY = clientY - orect.top - disp.y;
    const sx = srcW / disp.w;
    const sy = srcH / disp.h;
    return {
      x: Math.max(0, Math.min(srcW, localX * sx)),
      y: Math.max(0, Math.min(srcH, localY * sy)),
    };
  }

  function onOverlayDown(e) {
    if (!srcW || !srcH) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const p = overlayPointToSource(e.clientX, e.clientY);
    if (!p) return;
    cropDrag = {
      mode: "create",
      startSrc: p,
    };
    didDrag = false;
    window.addEventListener("mousemove", onCropMove, true);
    window.addEventListener("mouseup", onCropUp, true);
  }

  function onCropBodyDown(e) {
    if (!crop) return;
    e.preventDefault();
    e.stopPropagation();
    const p = overlayPointToSource(e.clientX, e.clientY);
    if (!p) return;
    cropDrag = {
      mode: "move",
      startSrc: p,
      startRect: { ...crop },
    };
    window.addEventListener("mousemove", onCropMove, true);
    window.addEventListener("mouseup", onCropUp, true);
  }

  function onCropHandleDown(handle, e) {
    if (!crop) return;
    e.preventDefault();
    e.stopPropagation();
    const p = overlayPointToSource(e.clientX, e.clientY);
    if (!p) return;
    cropDrag = {
      mode: "resize",
      handle,
      startSrc: p,
      startRect: { ...crop },
    };
    window.addEventListener("mousemove", onCropMove, true);
    window.addEventListener("mouseup", onCropUp, true);
  }

  function onCropMove(e) {
    if (!cropDrag) return;
    const p = overlayPointToSource(e.clientX, e.clientY);
    if (!p) return;
    const ratio = getAspectRatio();

    if (cropDrag.mode === "create") {
      const x0 = cropDrag.startSrc.x;
      const y0 = cropDrag.startSrc.y;
      let x = Math.min(x0, p.x);
      let y = Math.min(y0, p.y);
      let w = Math.abs(p.x - x0);
      let h = Math.abs(p.y - y0);
      if (ratio) {
        const adj = applyAspect(w, h, ratio);
        w = adj.w;
        h = adj.h;
        if (p.x < x0) x = x0 - w;
        if (p.y < y0) y = y0 - h;
      }
      const rect = clampCropToSource({ x, y, w, h });
      if (rect.w > 4 && rect.h > 4) {
        onCropChange(rect);
      }
    } else if (cropDrag.mode === "move") {
      const dx = p.x - cropDrag.startSrc.x;
      const dy = p.y - cropDrag.startSrc.y;
      const r = cropDrag.startRect;
      let nx = r.x + dx;
      let ny = r.y + dy;
      nx = Math.max(0, Math.min(srcW - r.w, nx));
      ny = Math.max(0, Math.min(srcH - r.h, ny));
      onCropChange({ x: Math.round(nx), y: Math.round(ny), w: r.w, h: r.h });
    } else if (cropDrag.mode === "resize") {
      const r = cropDrag.startRect;
      const handle = cropDrag.handle;
      let x = r.x, y = r.y, w = r.w, h = r.h;

      const hasL = handle.includes("w");
      const hasR = handle.includes("e");
      const hasT = handle.includes("n");
      const hasB = handle.includes("s");

      if (hasL) { const nx = Math.max(0, Math.min(p.x, r.x + r.w - 4)); w = r.w + (r.x - nx); x = nx; }
      if (hasR) { const nw = Math.max(4, Math.min(srcW - r.x, p.x - r.x)); w = nw; }
      if (hasT) { const ny = Math.max(0, Math.min(p.y, r.y + r.h - 4)); h = r.h + (r.y - ny); y = ny; }
      if (hasB) { const nh = Math.max(4, Math.min(srcH - r.y, p.y - r.y)); h = nh; }

      if (ratio) {
        // For corner handles preserve aspect; for edge handles let aspect drive the orthogonal axis
        if (hasL || hasR) {
          const newH = w / ratio;
          if (hasT) { y = (r.y + r.h) - newH; }
          else { /* default anchor top */ }
          h = newH;
        } else if (hasT || hasB) {
          const newW = h * ratio;
          if (hasL) { x = (r.x + r.w) - newW; }
          h = h;
          w = newW;
        }
      }

      const rect = clampCropToSource({ x, y, w, h });
      if (rect.w > 4 && rect.h > 4) {
        onCropChange(rect);
      }
    }
  }

  function onCropUp() {
    cropDrag = null;
    window.removeEventListener("mousemove", onCropMove, true);
    window.removeEventListener("mouseup", onCropUp, true);
  }

  function resetCrop() {
    onCropChange(null);
  }

  function setAspect(mode) {
    aspectMode = mode;
    const ratio = getAspectRatio();
    if (crop && ratio) {
      // Re-apply ratio to existing crop, anchored top-left
      const adj = applyAspect(crop.w, crop.h, ratio);
      const rect = clampCropToSource({ x: crop.x, y: crop.y, w: adj.w, h: adj.h });
      onCropChange(rect);
    }
  }

  // Transform actions
  function rotateBy(deg) {
    const next = (((rotate || 0) + deg) % 360 + 360) % 360;
    onRotateChange(next);
  }
  function toggleFlipH() { onFlipHChange(!flipH); }
  function toggleFlipV() { onFlipVChange(!flipV); }
  function resetTransform() {
    onRotateChange(0);
    onFlipHChange(false);
    onFlipVChange(false);
  }

  $: transformLabel = (() => {
    const parts = [];
    if (rotate) parts.push(`${rotate}°`);
    if (flipH) parts.push("flip-H");
    if (flipV) parts.push("flip-V");
    return parts.join(" + ") || "None";
  })();

  // Speed
  const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];
  function setSpeed(v) {
    const clamped = Math.max(0.1, Math.min(10, v));
    onSpeedChange(clamped);
  }
  function onSpeedInput(e) {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) setSpeed(v);
  }

  // Volume — preview uses videoEl.volume up to 100%, WebAudio gain above.
  let audioCtx;
  let gainNode;
  let srcNode;
  let webAudioEnabled = false;

  function ensureWebAudio() {
    if (webAudioEnabled || !videoEl) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      srcNode = audioCtx.createMediaElementSource(videoEl);
      gainNode = audioCtx.createGain();
      srcNode.connect(gainNode).connect(audioCtx.destination);
      webAudioEnabled = true;
    } catch (_) {
      webAudioEnabled = false;
    }
  }

  $: if (videoEl) {
    const pct = Math.max(0, Math.min(200, volume == null ? 100 : volume)) / 100;
    if (pct > 1 && !webAudioEnabled) ensureWebAudio();
    if (webAudioEnabled && gainNode) {
      videoEl.volume = 1;
      gainNode.gain.value = pct;
    } else {
      videoEl.volume = Math.min(1, pct);
    }
  }

  function setVolume(v) {
    const clamped = Math.max(0, Math.min(200, Math.round(v)));
    onVolumeChange(clamped);
  }
  function onVolumeSlider(e) {
    setVolume(parseInt(e.target.value, 10));
  }
  function resetVolume() { onVolumeChange(100); }
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

  <div class="editor-grid">
  <div class="editor-left">
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

      {#if showVideoEdits && cropOpen && srcW > 0 && srcH > 0}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="crop-overlay"
          bind:this={overlayEl}
          on:mousedown={onOverlayDown}
        >
          {#if overlayRect}
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              class="crop-rect"
              style="left: {overlayRect.x}px; top: {overlayRect.y}px; width: {overlayRect.w}px; height: {overlayRect.h}px;"
              on:mousedown={onCropBodyDown}
            >
              <div class="crop-handle nw" on:mousedown={(e) => onCropHandleDown("nw", e)}></div>
              <div class="crop-handle n"  on:mousedown={(e) => onCropHandleDown("n", e)}></div>
              <div class="crop-handle ne" on:mousedown={(e) => onCropHandleDown("ne", e)}></div>
              <div class="crop-handle e"  on:mousedown={(e) => onCropHandleDown("e", e)}></div>
              <div class="crop-handle se" on:mousedown={(e) => onCropHandleDown("se", e)}></div>
              <div class="crop-handle s"  on:mousedown={(e) => onCropHandleDown("s", e)}></div>
              <div class="crop-handle sw" on:mousedown={(e) => onCropHandleDown("sw", e)}></div>
              <div class="crop-handle w"  on:mousedown={(e) => onCropHandleDown("w", e)}></div>
            </div>
          {/if}
        </div>
      {/if}

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
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="playhead"
          class:active={dragging === "playhead"}
          style="left: {playheadPct}%"
          on:mousedown={onPlayheadDown}
          title="Drag to scrub"
        ></div>
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
  </div><!-- /.editor-left -->

  <div class="editor-right">
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

  {#if showVideoEdits}
    <div class="sub-section">
      <button class="sub-head" on:click={() => (cropOpen = !cropOpen)}>
        <svg class="chevron" class:open={cropOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        <span>Crop</span>
        {#if crop}<span class="sub-tag">{crop.w}×{crop.h}</span>{/if}
      </button>
      {#if cropOpen}
        <div class="sub-body">
          <div class="chip-row">
            {#each ["free", "1:1", "16:9", "9:16"] as a}
              <button class="chip" class:active={aspectMode === a} on:click={() => setAspect(a)}>
                {a === "free" ? "Free" : a}
              </button>
            {/each}
            <button class="chip ghost" on:click={resetCrop} disabled={!crop}>Reset</button>
          </div>
          <div class="hint">
            {#if !crop}
              Click and drag on the preview to set a crop region.
            {:else}
              x: {crop.x} · y: {crop.y} · {crop.w}×{crop.h} px
            {/if}
          </div>
        </div>
      {/if}
    </div>

    <div class="sub-section">
      <button class="sub-head" on:click={() => (transformOpen = !transformOpen)}>
        <svg class="chevron" class:open={transformOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        <span>Transform</span>
        <span class="sub-tag">{transformLabel}</span>
      </button>
      {#if transformOpen}
        <div class="sub-body">
          <div class="chip-row">
            <button class="icon-chip" on:click={() => rotateBy(-90)} title="Rotate 90° counter-clockwise">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              <span>90° CCW</span>
            </button>
            <button class="icon-chip" on:click={() => rotateBy(90)} title="Rotate 90° clockwise">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              <span>90° CW</span>
            </button>
            <button class="icon-chip" class:active={flipH} on:click={toggleFlipH} title="Flip horizontal">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18"/><path d="M3 8l4 4-4 4"/><path d="M21 8l-4 4 4 4"/></svg>
              <span>Flip H</span>
            </button>
            <button class="icon-chip" class:active={flipV} on:click={toggleFlipV} title="Flip vertical">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18"/><path d="M8 3l4 4 4-4"/><path d="M8 21l4-4 4 4"/></svg>
              <span>Flip V</span>
            </button>
            <button class="chip ghost" on:click={resetTransform} disabled={!rotate && !flipH && !flipV}>Reset</button>
          </div>
        </div>
      {/if}
    </div>

    <div class="sub-section">
      <button class="sub-head" on:click={() => (speedOpen = !speedOpen)}>
        <svg class="chevron" class:open={speedOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        <span>Playback speed</span>
        <span class="sub-tag">{(speed || 1).toString().replace(/\.?0+$/, "")}×</span>
      </button>
      {#if speedOpen}
        <div class="sub-body">
          <div class="chip-row">
            {#each SPEED_PRESETS as preset}
              <button class="chip" class:active={speed === preset} on:click={() => setSpeed(preset)}>
                {preset}×
              </button>
            {/each}
          </div>
          <div class="speed-input-row">
            <label>Custom</label>
            <input
              type="number"
              step="0.05"
              min="0.1"
              max="10"
              value={speed || 1}
              on:input={onSpeedInput}
            />
            <span class="speed-x">×</span>
          </div>
        </div>
      {/if}
    </div>

    {#if !stripAudio}
      <div class="volume-section">
        <div class="volume-header">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>
          <span class="vol-label">Volume</span>
          <span class="vol-value">{volume == null ? 100 : volume}%</span>
          <button class="chip ghost vol-reset" on:click={resetVolume} disabled={(volume == null ? 100 : volume) === 100}>Reset</button>
        </div>
        <input
          type="range"
          min="0"
          max="200"
          step="1"
          value={volume == null ? 100 : volume}
          on:input={onVolumeSlider}
          class="vol-slider"
          aria-label="Volume"
        />
        <div class="volume-ticks">
          <span>0%</span>
          <span class="tick-100">100%</span>
          <span>200%</span>
        </div>
      </div>
    {/if}
  {/if}
  </div><!-- /.editor-right -->
  </div><!-- /.editor-grid -->
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

  .editor-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 14px;
    align-items: start;
  }

  .editor-left,
  .editor-right {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  @media (min-width: 900px) {
    .editor-grid {
      grid-template-columns: minmax(0, 1fr) minmax(280px, 340px);
    }
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

  .preview-container {
    position: relative;
    margin-bottom: 12px;
    border-radius: 6px;
    overflow: hidden;
    background: #000;
    aspect-ratio: 16 / 9;
    max-height: 45vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .video-preview {
    width: 100%;
    height: 100%;
    max-height: 45vh;
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
    z-index: 6;
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
    z-index: 6;
  }

  /* Crop overlay */
  .crop-overlay {
    position: absolute;
    inset: 0;
    z-index: 5;
    cursor: crosshair;
  }

  .crop-rect {
    position: absolute;
    border: 1.5px solid var(--accent);
    box-shadow: 0 0 0 9999px rgba(0,0,0,0.45);
    cursor: move;
    box-sizing: border-box;
  }

  .crop-handle {
    position: absolute;
    width: 10px;
    height: 10px;
    background: var(--accent);
    border: 1px solid #fff;
    border-radius: 2px;
    box-shadow: 0 0 4px rgba(0,0,0,0.5);
  }
  .crop-handle.nw { top: -5px; left: -5px; cursor: nwse-resize; }
  .crop-handle.ne { top: -5px; right: -5px; cursor: nesw-resize; }
  .crop-handle.sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
  .crop-handle.se { bottom: -5px; right: -5px; cursor: nwse-resize; }
  .crop-handle.n  { top: -5px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
  .crop-handle.s  { bottom: -5px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
  .crop-handle.w  { top: 50%; left: -5px; transform: translateY(-50%); cursor: ew-resize; }
  .crop-handle.e  { top: 50%; right: -5px; transform: translateY(-50%); cursor: ew-resize; }

  .timeline { margin-bottom: 12px; }

  .tick-bar {
    position: relative;
    height: 16px;
    margin-bottom: 4px;
  }

  .tick { position: absolute; transform: translateX(-50%); }

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
    top: -6px;
    bottom: -6px;
    width: 16px;
    margin-left: -8px;
    z-index: 4;
    cursor: ew-resize;
    display: flex;
    justify-content: center;
    background: transparent;
  }

  .playhead::before {
    content: "";
    width: 2px;
    height: 100%;
    background: #fff;
    border-radius: 1px;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.5);
    transition: width 0.12s ease, box-shadow 0.12s ease;
  }

  .playhead:hover::before,
  .playhead.active::before {
    width: 3px;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.85);
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

  .time-value.accent { color: var(--accent); }

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

  /* Sub-sections (crop/transform/speed) */
  .sub-section {
    margin-top: 10px;
    border-top: 1px solid var(--border);
  }

  .sub-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 0 8px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 600;
    text-align: left;
  }

  .sub-head:hover { color: var(--text-primary); }

  .sub-tag {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .chevron { transition: transform 0.2s ease; flex-shrink: 0; }
  .chevron.open { transform: rotate(90deg); }

  .sub-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-bottom: 10px;
    animation: fadeUp 0.2s ease-out;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    padding: 5px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-secondary);
    font-size: 0.74rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .chip:hover:not(:disabled) {
    border-color: var(--border-hover);
    color: var(--text-primary);
  }

  .chip.active {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--accent);
  }

  .chip:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .chip.ghost {
    background: transparent;
  }

  .icon-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-secondary);
    font-size: 0.74rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .icon-chip:hover {
    border-color: var(--border-hover);
    color: var(--text-primary);
  }

  .icon-chip.active {
    background: var(--accent-subtle);
    border-color: var(--accent);
    color: var(--accent);
  }

  .hint {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .speed-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .speed-input-row label {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-weight: 500;
    width: 60px;
    flex-shrink: 0;
  }

  .speed-input-row input {
    width: 80px;
    padding: 5px 8px;
    background: var(--bg-input);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    font-family: inherit;
    font-size: 0.78rem;
    outline: none;
  }

  .speed-input-row input:focus { border-color: var(--accent-dim); }

  .volume-section {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
  }

  .volume-header {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 600;
    margin-bottom: 6px;
  }

  .volume-header svg { color: var(--accent); }

  .vol-label { letter-spacing: -0.01em; }

  .vol-value {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--text-primary);
    font-weight: 600;
  }

  .vol-reset { padding: 3px 10px; font-size: 0.7rem; }

  .vol-slider {
    width: 100%;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    border-radius: 2px;
    outline: none;
    background: var(--border);
  }

  .vol-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 2px solid var(--bg-card);
    box-shadow: 0 0 0 1px var(--accent-dim);
  }

  .volume-ticks {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    font-size: 0.62rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .volume-ticks .tick-100 { color: var(--text-secondary); }

  .speed-x {
    font-size: 0.78rem;
    color: var(--text-muted);
  }
</style>
