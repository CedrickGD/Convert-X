<script>
  import { onDestroy } from "svelte";
  import { hexToHsv, hsvToHex } from "../lib/color.js";

  /**
   * Saturation/brightness square + hue slider — port of the Android
   * ColorPicker (packages/android/src/components/ColorPicker.tsx), same
   * gesture idiom as ClipEditor's drag handles (pointerdown + window
   * listeners) so it works with mouse, pen and touch.
   */

  /** Current colour as a hex string, e.g. "#7c3aed". */
  export let value = "#10b981";
  /** Fires continuously while dragging — re-theme live, don't persist. */
  export let onPreview = () => {};
  /** Fires once when a gesture settles — persist this value. */
  export let onCommit = () => {};

  const start = hexToHsv(value) ?? { h: 160, s: 0.8, v: 0.7 };
  let hue = start.h;
  let sat = start.s;
  let val = start.v;

  let svEl;
  let hueEl;
  let dragging = null; // "sv" | "hue" | null

  // The last hex we produced. Used to (a) dedupe preview spam and (b) ignore
  // the parent echoing our own value back so the sync below doesn't fight a
  // drag.
  let lastHex = value;
  // The hex most recently HANDED to the parent (the throttle can hold newer
  // ones back) — needed to recognise stale echoes.
  let lastDelivered = value;

  // Preview throttle (~30 Hz, trailing edge). Every preview rewrites the
  // root custom properties and restyles the whole document, so forwarding
  // raw pointer-event rate (60-144 Hz) burns layout for no visible gain.
  // The commit path stays unthrottled.
  const PREVIEW_MS = 33;
  let previewTimer = null;
  let pendingPreview = null;
  let lastPreviewAt = 0;

  onDestroy(() => {
    if (previewTimer) clearTimeout(previewTimer);
    stopDrag();
  });

  function emit(commit) {
    const hex = hsvToHex(hue, sat, val);
    if (commit) {
      if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
      }
      pendingPreview = null;
      lastHex = hex;
      lastDelivered = hex;
      onCommit(hex);
      return;
    }
    if (hex === lastHex) return;
    lastHex = hex;
    const now = Date.now();
    if (now - lastPreviewAt >= PREVIEW_MS) {
      lastPreviewAt = now;
      lastDelivered = hex;
      onPreview(hex);
    } else {
      pendingPreview = hex;
      if (!previewTimer) {
        previewTimer = setTimeout(() => {
          previewTimer = null;
          if (pendingPreview === null) return;
          lastPreviewAt = Date.now();
          const next = pendingPreview;
          pendingPreview = null;
          lastDelivered = next;
          onPreview(next);
        }, PREVIEW_MS);
      }
    }
  }

  // External value change (swatch tap, reset, typed hex) → move the thumbs.
  // Skip our own echoes to avoid a feedback loop: lastDelivered matters
  // because the throttle advances lastHex AHEAD of what the parent has
  // actually received, and an echo of the previously delivered hex mid-drag
  // must not snap the thumbs back.
  $: syncExternal(value);

  function syncExternal(v) {
    if (v === lastHex || v === lastDelivered) return;
    if (pendingPreview !== null) return; // mid-drag, echoes are stale
    const hsv = hexToHsv(v);
    if (!hsv) return;
    hue = hsv.h;
    sat = hsv.s;
    val = hsv.v;
    lastHex = v;
    lastDelivered = v;
  }

  const clamp01 = (n) => Math.min(1, Math.max(0, n));

  function applySv(clientX, clientY) {
    if (!svEl) return;
    const r = svEl.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    sat = clamp01((clientX - r.left) / r.width);
    val = 1 - clamp01((clientY - r.top) / r.height);
    emit(false);
  }

  function applyHue(clientX) {
    if (!hueEl) return;
    const r = hueEl.getBoundingClientRect();
    if (r.width <= 0) return;
    hue = clamp01((clientX - r.left) / r.width) * 360;
    emit(false);
  }

  function onDown(which, e) {
    e.preventDefault();
    dragging = which;
    if (which === "sv") applySv(e.clientX, e.clientY);
    else applyHue(e.clientX);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
  }

  function onMove(e) {
    if (!dragging) return;
    e.preventDefault();
    if (dragging === "sv") applySv(e.clientX, e.clientY);
    else applyHue(e.clientX);
  }

  function onUp() {
    if (!dragging) return;
    stopDrag();
    emit(true);
  }

  function stopDrag() {
    dragging = null;
    if (typeof window === "undefined") return;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
  }

  // Keyboard nudges — the square moves saturation/brightness, the track hue.
  // Each keypress is its own committed change (no drag to settle).
  function onSvKey(e) {
    const step = e.shiftKey ? 0.1 : 0.02;
    let handled = true;
    if (e.key === "ArrowLeft") sat = clamp01(sat - step);
    else if (e.key === "ArrowRight") sat = clamp01(sat + step);
    else if (e.key === "ArrowUp") val = clamp01(val + step);
    else if (e.key === "ArrowDown") val = clamp01(val - step);
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    emit(true);
  }

  function onHueKey(e) {
    const step = e.shiftKey ? 24 : 4;
    let handled = true;
    if (e.key === "ArrowLeft") hue = (hue - step + 360) % 360;
    else if (e.key === "ArrowRight") hue = (hue + step) % 360;
    else if (e.key === "Home") hue = 0;
    else if (e.key === "End") hue = 359;
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    emit(true);
  }

  $: hueBase = hsvToHex(hue, 1, 1);
  $: swatch = hsvToHex(hue, sat, val);
</script>

<div class="picker">
  <div
    class="sv"
    class:dragging={dragging === "sv"}
    bind:this={svEl}
    role="slider"
    tabindex="0"
    aria-label="Saturation and brightness"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={Math.round(sat * 100)}
    aria-valuetext={`saturation ${Math.round(sat * 100)}%, brightness ${Math.round(val * 100)}%`}
    style={`background-color: ${hueBase}`}
    on:pointerdown={(e) => onDown("sv", e)}
    on:keydown={onSvKey}
  >
    <div class="sv-white"></div>
    <div class="sv-black"></div>
    <div
      class="thumb sv-thumb"
      style={`left: ${sat * 100}%; top: ${(1 - val) * 100}%; background: ${swatch}`}
    ></div>
  </div>

  <div
    class="hue"
    class:dragging={dragging === "hue"}
    bind:this={hueEl}
    role="slider"
    tabindex="0"
    aria-label="Hue"
    aria-valuemin="0"
    aria-valuemax="360"
    aria-valuenow={Math.round(hue)}
    on:pointerdown={(e) => onDown("hue", e)}
    on:keydown={onHueKey}
  >
    <div
      class="thumb hue-thumb"
      style={`left: ${(hue / 360) * 100}%; background: ${hueBase}`}
    ></div>
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .sv {
    position: relative;
    height: 150px;
    border-radius: var(--radius-xs);
    border: 1px solid var(--border);
    cursor: crosshair;
    touch-action: none;
    overflow: hidden;
  }

  .sv-white,
  .sv-black {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .sv-white { background: linear-gradient(to right, #ffffff, rgba(255, 255, 255, 0)); }
  .sv-black { background: linear-gradient(to bottom, rgba(0, 0, 0, 0), #000000); }

  .hue {
    position: relative;
    height: 14px;
    border-radius: 999px;
    border: 1px solid var(--border);
    cursor: pointer;
    touch-action: none;
    background: linear-gradient(
      to right,
      #ff0000 0%,
      #ffff00 16.666%,
      #00ff00 33.333%,
      #00ffff 50%,
      #0000ff 66.666%,
      #ff00ff 83.333%,
      #ff0000 100%
    );
  }

  .sv:focus-visible,
  .hue:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .thumb {
    position: absolute;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 3px solid #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
    pointer-events: none;
    transform: translate(-50%, -50%);
  }

  .sv-thumb { transition: none; }

  .hue-thumb {
    top: 50%;
    width: 20px;
    height: 20px;
  }

  .sv.dragging,
  .hue.dragging {
    /* Keeps the cursor from flickering while the pointer leaves the box. */
    cursor: grabbing;
  }
</style>
