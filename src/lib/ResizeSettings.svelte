<script>
  export let files = [];
  export let settings;
  export let onUpdate;

  $: imageFiles = files.filter((f) => f.detectedType === "image" && f.metadata);
  $: firstFile = imageFiles[0];
  $: origRes = firstFile?.metadata?.resolution || "";
  $: origWidth = origRes ? parseInt(origRes.split("x")[0]) || 0 : 0;
  $: origHeight = origRes ? parseInt(origRes.split("x")[1]) || 0 : 0;
  $: aspectRatio = origHeight > 0 ? origWidth / origHeight : 1;
  $: isBatchImages = imageFiles.length > 1;

  // Calculate preview dimensions
  $: previewDims = (() => {
    if (origWidth === 0 || origHeight === 0) return { w: 0, h: 0 };
    if (settings.resizeMode === "percentage") {
      const pct = (settings.resizePercent || 100) / 100;
      return {
        w: Math.max(1, Math.round(origWidth * pct)),
        h: Math.max(1, Math.round(origHeight * pct)),
      };
    } else {
      let w = settings.resizeWidth || origWidth;
      let h = settings.resizeHeight || origHeight;
      if (settings.keepAspect) {
        if (settings.resizeWidth && settings.resizeWidth !== origWidth) {
          h = Math.max(1, Math.round(w / aspectRatio));
        } else if (settings.resizeHeight && settings.resizeHeight !== origHeight) {
          w = Math.max(1, Math.round(h * aspectRatio));
        }
      }
      return { w, h };
    }
  })();

  function setMode(mode) {
    onUpdate({ ...settings, resizeMode: mode });
  }

  function setPercent(pct) {
    onUpdate({ ...settings, resizePercent: Math.max(1, pct) });
  }

  function setWidth(val) {
    const w = val ? Math.max(1, val) : null;
    const updates = { ...settings, resizeWidth: w };
    if (settings.keepAspect && w && origWidth > 0) {
      updates.resizeHeight = Math.max(1, Math.round(w / aspectRatio));
    }
    onUpdate(updates);
  }

  function setHeight(val) {
    const h = val ? Math.max(1, val) : null;
    const updates = { ...settings, resizeHeight: h };
    if (settings.keepAspect && h && origHeight > 0) {
      updates.resizeWidth = Math.max(1, Math.round(h * aspectRatio));
    }
    onUpdate(updates);
  }

  function toggleAspect() {
    const newKeep = !settings.keepAspect;
    const updates = { ...settings, keepAspect: newKeep };
    if (newKeep && settings.resizeWidth && origWidth > 0) {
      updates.resizeHeight = Math.max(1, Math.round(settings.resizeWidth / aspectRatio));
    }
    onUpdate(updates);
  }

  function setFormat(fmt) {
    onUpdate({ ...settings, resizeFormat: fmt === "same" ? null : fmt });
  }

  const PRESETS = [25, 50, 75, 125, 150, 200];
  const FORMATS = ["same", "png", "jpg", "webp", "bmp", "tiff"];
</script>

<div class="resize-card">
  <span class="section-label">Resize</span>

  {#if origWidth > 0}
    <div class="original-dims">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
      <span>
        {origWidth} <span class="times">&times;</span> {origHeight}
        {#if isBatchImages}
          <span class="varies">(first file)</span>
        {/if}
      </span>
    </div>
  {/if}

  <!-- Mode toggle -->
  <div class="mode-toggle">
    <button class="mode-btn" class:active={settings.resizeMode === "pixels"} on:click={() => setMode("pixels")}>
      Pixels
    </button>
    <button class="mode-btn" class:active={settings.resizeMode === "percentage"} on:click={() => setMode("percentage")}>
      Percentage
    </button>
  </div>

  {#if settings.resizeMode === "pixels"}
    <div class="pixel-section">
      <div class="dim-row">
        <div class="dim-field">
          <span class="dim-label">W</span>
          <input
            type="number"
            min="1"
            value={settings.resizeWidth || ""}
            on:input={(e) => setWidth(parseInt(e.target.value) || null)}
            placeholder={origWidth || "Width"}
          />
        </div>

        <span class="times-sep">&times;</span>

        <div class="dim-field">
          <span class="dim-label">H</span>
          <input
            type="number"
            min="1"
            value={settings.resizeHeight || ""}
            on:input={(e) => setHeight(parseInt(e.target.value) || null)}
            placeholder={origHeight || "Height"}
          />
        </div>

        <button
          class="lock-btn"
          class:locked={settings.keepAspect}
          on:click={toggleAspect}
          title={settings.keepAspect ? "Unlock aspect ratio" : "Lock aspect ratio"}
        >
          {#if settings.keepAspect}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 9.9-1"/>
            </svg>
          {/if}
        </button>
      </div>
    </div>

  {:else}
    <div class="percent-section">
      <div class="percent-input-row">
        <input
          type="number"
          min="1"
          max="1000"
          value={settings.resizePercent}
          on:input={(e) => setPercent(parseInt(e.target.value) || 1)}
          class="percent-input"
        />
        <span class="pct-sign">%</span>
      </div>

      <div class="presets">
        {#each PRESETS as pct}
          <button
            class="preset-btn"
            class:active={settings.resizePercent === pct}
            on:click={() => setPercent(pct)}
          >
            {pct}%
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if previewDims.w > 0 && previewDims.h > 0}
    <div class="output-dims">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      <span>Output: <strong>{previewDims.w} <span class="times">&times;</span> {previewDims.h}</strong></span>
    </div>
  {/if}

  <!-- Output format -->
  <div class="format-section">
    <span class="sub-label">Output format</span>
    <div class="format-grid">
      {#each FORMATS as fmt}
        <button
          class="fmt-btn"
          class:selected={(fmt === "same" && !settings.resizeFormat) || settings.resizeFormat === fmt}
          on:click={() => setFormat(fmt)}
        >
          {fmt === "same" ? "Same" : fmt.toUpperCase()}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .resize-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: fadeUp 0.3s ease-out;
  }

  .section-label {
    font-size: 0.68rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .original-dims {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .original-dims svg { color: var(--text-muted); }

  .times { color: var(--text-muted); margin: 0 1px; }

  .varies {
    font-size: 0.68rem;
    color: var(--text-muted);
    margin-left: 4px;
  }

  /* Mode toggle */
  .mode-toggle {
    display: flex;
    gap: 4px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 3px;
  }

  .mode-btn {
    flex: 1;
    padding: 6px 12px;
    border-radius: calc(var(--radius-xs) - 2px);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    background: transparent;
    transition: all var(--transition-fast);
  }

  .mode-btn:hover:not(.active) {
    color: var(--text-secondary);
  }

  .mode-btn.active {
    background: var(--bg-card);
    color: var(--text-primary);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  /* Pixel inputs */
  .pixel-section {
    animation: fadeUp 0.2s ease-out;
  }

  .dim-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .dim-field {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 0 10px;
    flex: 1;
    transition: border-color var(--transition-fast);
  }

  .dim-field:focus-within { border-color: var(--accent-dim); }

  .dim-label {
    font-size: 0.68rem;
    color: var(--text-muted);
    font-weight: 600;
    flex-shrink: 0;
  }

  .dim-field input {
    width: 100%;
    padding: 8px 0;
    font-size: 0.82rem;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
  }

  .dim-field input::-webkit-outer-spin-button,
  .dim-field input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .dim-field input::placeholder { color: var(--text-muted); }

  .times-sep {
    color: var(--text-muted);
    font-size: 0.85rem;
    flex-shrink: 0;
  }

  .lock-btn {
    width: 34px;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-xs);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    color: var(--text-muted);
    flex-shrink: 0;
    transition: all var(--transition-fast);
  }

  .lock-btn:hover {
    border-color: var(--border-hover);
    color: var(--text-secondary);
  }

  .lock-btn.locked {
    color: var(--accent);
    border-color: var(--accent-dim);
    background: var(--accent-subtle);
  }

  /* Percentage */
  .percent-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: fadeUp 0.2s ease-out;
  }

  .percent-input-row {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 0 10px;
    width: 120px;
    transition: border-color var(--transition-fast);
  }

  .percent-input-row:focus-within { border-color: var(--accent-dim); }

  .percent-input {
    width: 80px;
    padding: 8px 0;
    font-size: 0.85rem;
    font-weight: 600;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
  }

  .percent-input::-webkit-outer-spin-button,
  .percent-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .pct-sign {
    font-size: 0.82rem;
    color: var(--accent);
    font-weight: 700;
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .preset-btn {
    padding: 6px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-secondary);
    font-size: 0.72rem;
    font-weight: 600;
    transition: all var(--transition-fast);
  }

  .preset-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-hover);
  }

  .preset-btn.active {
    background: var(--accent);
    color: var(--btn-primary-text);
    border-color: var(--accent);
  }

  /* Output dimensions preview */
  .output-dims {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    background: var(--accent-subtle);
    border: 1px solid var(--accent-dim);
    border-radius: var(--radius-xs);
    font-size: 0.78rem;
    color: var(--text-secondary);
  }

  .output-dims svg { color: var(--accent); }
  .output-dims strong { color: var(--text-primary); }

  /* Format section */
  .format-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .sub-label {
    font-size: 0.68rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .format-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .fmt-btn {
    padding: 6px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-secondary);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    transition: all var(--transition-fast);
  }

  .fmt-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-hover);
  }

  .fmt-btn.selected {
    background: var(--accent);
    color: var(--btn-primary-text);
    border-color: var(--accent);
    font-weight: 700;
  }
</style>
