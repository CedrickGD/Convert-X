<script>
  import { getPlatform } from "../platform.js";

  export let outputDir;
  export let quality;
  export let selectedFormat;
  export let isBatch = false;
  export let singleOutputName = "";
  export let onNameChange;
  export let onDirChange;
  export let onQualityChange;

  $: isWeb = getPlatform().platformType === "web";
  $: qualityLabel = selectedFormat === "gif" ? "GIF quality" : "Quality";
  $: qualityHighLabel = selectedFormat === "gif" ? "Cleaner" : "Better";

  async function pickFolder() {
    const result = await getPlatform().pickFolder();
    if (result) onDirChange(result);
  }

  function truncateDir(dir) {
    if (!dir) return "Same as source";
    if (dir.length <= 38) return dir;
    return "..." + dir.slice(-35);
  }
</script>

<div class="settings">
  <!-- Filename (single file only) -->
  {#if !isBatch}
    <div class="field">
      <span class="label">File name</span>
      <div class="input-row">
        <input
          type="text"
          class="name-input"
          value={singleOutputName}
          on:input={(e) => onNameChange(e.target.value)}
          placeholder="output filename"
          spellcheck="false"
        />
        {#if selectedFormat}
          <span class="ext">.{selectedFormat}</span>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Output directory -->
  {#if !isWeb}
  <div class="field">
    <span class="label">Save to</span>
    <button class="dir-btn" on:click={pickFolder}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="dir-path">{truncateDir(outputDir)}</span>
      <span class="change">Change</span>
    </button>
  </div>
  {/if}

  <div class="field">
    <div class="quality-head">
      <span class="label">{qualityLabel}</span>
      <span class="quality-val">{quality}%</span>
    </div>
    <div class="slider-wrap">
      <input
        type="range"
        min="1"
        max="100"
        value={quality}
        on:input={(e) => onQualityChange(parseInt(e.target.value))}
        class="slider"
        style="--val: {quality}%"
      />
      <div class="slider-labels">
        <span>Smaller</span>
        <span>{qualityHighLabel}</span>
      </div>
    </div>
  </div>
</div>

<style>
  .settings {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    animation: fadeUp 0.35s ease-out;
  }

  .field { display: flex; flex-direction: column; gap: 5px; }

  .label {
    font-size: 0.68rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }

  .input-row {
    display: flex;
    align-items: center;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 0 10px;
    transition: border-color var(--transition-fast);
  }

  .input-row:focus-within { border-color: var(--accent-dim); }

  .name-input {
    flex: 1;
    padding: 8px 0;
    font-size: 0.82rem;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: inherit;
  }

  .name-input::placeholder { color: var(--text-muted); }

  .ext {
    color: var(--accent);
    font-size: 0.82rem;
    font-weight: 600;
    padding-left: 2px;
    flex-shrink: 0;
  }

  .dir-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 8px 10px;
    color: var(--text-secondary);
    font-size: 0.78rem;
    text-align: left;
    transition: all var(--transition-fast);
  }

  .dir-btn:hover { border-color: var(--border-hover); background: var(--bg-hover); }
  .dir-btn svg { flex-shrink: 0; color: var(--text-muted); }
  .dir-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .change { flex-shrink: 0; font-size: 0.7rem; color: var(--accent); font-weight: 600; }

  .quality-head { display: flex; justify-content: space-between; align-items: center; }
  .quality-head .label { margin-bottom: 0; }
  .quality-val { font-size: 0.78rem; color: var(--accent); font-weight: 700; font-variant-numeric: tabular-nums; }

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

  .slider::-webkit-slider-thumb:hover { box-shadow: 0 0 0 3px var(--accent-glow); }

  .slider-labels { display: flex; justify-content: space-between; margin-top: 4px; font-size: 0.65rem; color: var(--text-muted); }
</style>
