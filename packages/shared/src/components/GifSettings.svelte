<script>
  export let settings;
  export let onUpdate;
  export let hasDuration = false;

  const PRESETS = [
    { id: "original", label: "Original", desc: "Full res, max fidelity", width: null, fps: null, colors: 256, dither: "floyd_steinberg", quality: 100 },
    { id: "high", label: "High Quality", desc: "720p, smooth", width: 720, fps: 24, colors: 256, dither: "floyd_steinberg", quality: 90 },
    { id: "balanced", label: "Balanced", desc: "480p, good size", width: 480, fps: 15, colors: 256, dither: "sierra2_4a", quality: 75 },
    { id: "discord", label: "Discord", desc: "360p, share-friendly", width: 360, fps: 15, colors: 128, dither: "sierra2_4a", quality: 60 },
    { id: "compact", label: "Compact", desc: "240p, tiny file", width: 240, fps: 10, colors: 64, dither: "bayer", quality: 35 },
  ];

  const WIDTH_OPTIONS = [
    { value: null, label: "Original" },
    { value: 1280, label: "1280px" },
    { value: 720, label: "720px" },
    { value: 480, label: "480px" },
    { value: 360, label: "360px" },
    { value: 240, label: "240px" },
    { value: 160, label: "160px" },
  ];

  const FPS_OPTIONS = [
    { value: null, label: "Original" },
    { value: 30, label: "30 fps" },
    { value: 24, label: "24 fps" },
    { value: 15, label: "15 fps" },
    { value: 10, label: "10 fps" },
    { value: 5, label: "5 fps" },
  ];

  const DITHER_OPTIONS = [
    { value: "none", label: "None (flat colors)" },
    { value: "bayer", label: "Ordered (retro)" },
    { value: "floyd_steinberg", label: "Floyd-Steinberg" },
    { value: "sierra2_4a", label: "Sierra (smooth)" },
  ];

  const SIZE_CAP_OPTIONS = [
    { value: null, label: "Off" },
    { value: 5, label: "5 MB" },
    { value: 10, label: "10 MB" },
    { value: 25, label: "25 MB" },
  ];

  let showFineTune = false;

  $: gifColors = settings.gifColors;
  $: gifDither = settings.gifDither;
  $: gifWidth = settings.gifWidth;
  $: gifFps = settings.gifFps;

  $: activePreset = PRESETS.find((p) =>
    p.quality === settings.quality &&
    p.colors === gifColors &&
    p.dither === gifDither &&
    p.width === gifWidth &&
    (!hasDuration || p.fps === gifFps)
  )?.id || null;

  function selectPreset(preset) {
    const updates = {
      ...settings,
      quality: preset.quality,
      gifColors: preset.colors,
      gifDither: preset.dither,
      gifWidth: preset.width,
    };
    if (hasDuration) {
      updates.gifFps = preset.fps;
    }
    onUpdate(updates);
  }

  function updateField(key, value) {
    onUpdate({ ...settings, [key]: value });
  }
</script>

<div class="gif-settings">
  <span class="section-label">GIF Settings</span>

  <div class="presets">
    {#each PRESETS as preset}
      <button
        class="preset"
        class:active={activePreset === preset.id}
        on:click={() => selectPreset(preset)}
      >
        <span class="preset-name">{preset.label}</span>
        <span class="preset-desc">{preset.desc}</span>
      </button>
    {/each}
  </div>

  <div class="size-cap">
    <div class="size-cap-head">
      <span class="size-cap-label">Size cap</span>
      <span class="size-cap-value">
        {#if settings.gifTargetSizeMb}
          Under {settings.gifTargetSizeMb} MB
        {:else}
          No limit
        {/if}
      </span>
    </div>

    <div class="size-cap-grid">
      {#each SIZE_CAP_OPTIONS as option}
        <button
          class="cap-btn"
          class:active={settings.gifTargetSizeMb === option.value}
          on:click={() => updateField("gifTargetSizeMb", option.value)}
        >
          {option.label}
        </button>
      {/each}
    </div>

    {#if settings.gifTargetSizeMb}
      <p class="size-cap-note">
        Convert-X will keep compressing this GIF until it fits under the selected size cap.
      </p>
    {/if}
  </div>

  <button class="fine-tune-toggle" on:click={() => (showFineTune = !showFineTune)}>
    <svg
      class="chevron"
      class:open={showFineTune}
      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
    ><polyline points="9 18 15 12 9 6"/></svg>
    <span>Fine-tune</span>
  </button>

  {#if showFineTune}
    <div class="controls">
      <div class="opt">
        <label>Width</label>
        <select
          value={gifWidth || ""}
          on:change={(e) => updateField("gifWidth", e.target.value ? parseInt(e.target.value) : null)}
        >
          {#each WIDTH_OPTIONS as opt}
            <option value={opt.value || ""}>{opt.label}</option>
          {/each}
        </select>
      </div>

      {#if hasDuration}
        <div class="opt">
          <label>Frame rate</label>
          <select
            value={gifFps || ""}
            on:change={(e) => updateField("gifFps", e.target.value ? parseInt(e.target.value) : null)}
          >
            {#each FPS_OPTIONS as opt}
              <option value={opt.value || ""}>{opt.label}</option>
            {/each}
          </select>
        </div>
      {/if}

      <div class="opt-full">
        <div class="color-head">
          <label>Colors</label>
          <span class="color-val">{gifColors}</span>
        </div>
        <div class="slider-wrap">
          <input
            type="range"
            min="2"
            max="256"
            value={gifColors}
            on:input={(e) => updateField("gifColors", parseInt(e.target.value))}
            class="slider"
            style="--val: {((gifColors - 2) / 254) * 100}%"
          />
          <div class="slider-labels">
            <span>Fewer</span>
            <span>More</span>
          </div>
        </div>
      </div>

      <div class="opt">
        <label>Dithering</label>
        <select
          value={gifDither}
          on:change={(e) => updateField("gifDither", e.target.value)}
        >
          {#each DITHER_OPTIONS as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
    </div>
  {/if}
</div>

<style>
  .gif-settings {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: fadeUp 0.35s ease-out;
  }

  .section-label {
    font-size: 0.68rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .presets {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }

  .preset {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 8px 6px;
    background: var(--bg-input);
    border: 1.5px solid var(--border);
    border-radius: var(--radius-xs);
    transition: all var(--transition-fast);
    cursor: pointer;
  }

  .preset:hover:not(.active) {
    border-color: var(--border-hover);
    background: var(--bg-hover);
  }

  .preset.active {
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .preset-name {
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.2;
  }

  .preset.active .preset-name {
    color: var(--accent);
  }

  .preset-desc {
    font-size: 0.58rem;
    color: var(--text-muted);
    line-height: 1.2;
  }

  .size-cap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
  }

  .size-cap-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
  }

  .size-cap-label {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .size-cap-value {
    font-size: 0.72rem;
    color: var(--accent);
    font-weight: 700;
  }

  .size-cap-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }

  .cap-btn {
    padding: 7px 6px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 600;
  }

  .cap-btn:hover:not(.active) {
    border-color: var(--border-hover);
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .cap-btn.active {
    border-color: var(--accent);
    background: var(--accent-subtle);
    color: var(--accent);
  }

  .size-cap-note {
    margin: 0;
    font-size: 0.68rem;
    color: var(--text-muted);
    line-height: 1.35;
  }

  .fine-tune-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .fine-tune-toggle:hover {
    color: var(--text-primary);
  }

  .chevron {
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 10px;
    animation: fadeUp 0.2s ease-out;
  }

  .opt {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .opt label, .opt-full label {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .opt label {
    width: 80px;
    flex-shrink: 0;
  }

  select {
    flex: 1;
    padding: 6px 8px;
    background: var(--bg-input);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    font-family: inherit;
    font-size: 0.78rem;
    outline: none;
    cursor: pointer;
    transition: border-color var(--transition-fast);
  }

  select:hover { border-color: var(--border-hover); }
  select:focus { border-color: var(--accent-dim); }

  .opt-full {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .color-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .color-val {
    font-size: 0.78rem;
    color: var(--accent);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .slider-wrap { padding-top: 2px; }

  .slider {
    width: 100%;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    border-radius: 2px;
    outline: none;
    background: linear-gradient(to right, var(--accent) 0%, var(--accent) var(--val), var(--border) var(--val), var(--border) 100%);
  }

  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent);
    cursor: pointer;
    border: 2px solid var(--bg-card);
    box-shadow: 0 0 0 1px var(--accent-dim);
  }

  .slider::-webkit-slider-thumb:hover {
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .slider-labels {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    font-size: 0.65rem;
    color: var(--text-muted);
  }
</style>
