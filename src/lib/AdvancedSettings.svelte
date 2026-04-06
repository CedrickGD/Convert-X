<script>
  export let fileTypes = new Set();
  export let selectedFormat = null;
  export let settings = {};
  export let onUpdate;
  export let hasVideo = false;
  export let hasDuration = false;

  let open = false;

  $: showResolution = hasVideo || selectedFormat === "gif";
  $: showFps = hasVideo || selectedFormat === "gif";
  $: showTrim = false;
  $: showBitrate = hasVideo || fileTypes.has("audio");
  $: showPreset = ["mp4", "mkv", "mov", "m4v", "ts"].includes(selectedFormat);
  $: hasAnyOption = showResolution || showFps || showTrim || showBitrate || showPreset;

  function update(key, value) {
    onUpdate({ ...settings, [key]: value });
  }

  const RESOLUTIONS = [
    { label: "Original", value: null },
    { label: "1920x1080", value: "1920x1080" },
    { label: "1280x720", value: "1280x720" },
    { label: "854x480", value: "854x480" },
    { label: "640x360", value: "640x360" },
    { label: "320x240", value: "320x240" },
  ];

  const FPS_OPTIONS = [
    { label: "Original", value: null },
    { label: "60", value: 60 },
    { label: "30", value: 30 },
    { label: "24", value: 24 },
    { label: "15", value: 15 },
    { label: "10", value: 10 },
  ];

  const PRESETS = [
    "ultrafast", "superfast", "veryfast", "faster", "fast",
    "medium", "slow", "slower", "veryslow",
  ];

  const BITRATE_VIDEO = [
    { label: "Auto", value: null },
    { label: "1 Mbps", value: "1M" },
    { label: "2 Mbps", value: "2M" },
    { label: "5 Mbps", value: "5M" },
    { label: "10 Mbps", value: "10M" },
    { label: "20 Mbps", value: "20M" },
  ];

  const BITRATE_AUDIO = [
    { label: "Auto", value: null },
    { label: "64 kbps", value: "64k" },
    { label: "128 kbps", value: "128k" },
    { label: "192 kbps", value: "192k" },
    { label: "256 kbps", value: "256k" },
    { label: "320 kbps", value: "320k" },
  ];

  $: bitrateOptions = hasVideo ? BITRATE_VIDEO : BITRATE_AUDIO;
</script>

{#if hasAnyOption}
  <div class="advanced">
    <button class="toggle-head" on:click={() => (open = !open)}>
      <svg
        class="chevron"
        class:open
        width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
      ><polyline points="9 18 15 12 9 6"/></svg>
      <span>Advanced</span>
    </button>

    {#if open}
      <div class="options">
        {#if showResolution}
          <div class="opt">
            <label>Resolution</label>
            <select
              value={settings.resolution || ""}
              on:change={(e) => update("resolution", e.target.value || null)}
            >
              {#each RESOLUTIONS as r}
                <option value={r.value || ""}>{r.label}</option>
              {/each}
            </select>
          </div>
        {/if}

        {#if showFps}
          <div class="opt">
            <label>Frame rate</label>
            <select
              value={settings.fps || ""}
              on:change={(e) => update("fps", e.target.value ? parseInt(e.target.value) : null)}
            >
              {#each FPS_OPTIONS as f}
                <option value={f.value || ""}>{f.label}{f.value ? " fps" : ""}</option>
              {/each}
            </select>
          </div>
        {/if}

        {#if showTrim}
          <div class="opt trim-row">
            <label>Trim</label>
            <div class="trim-inputs">
              <input
                type="text"
                class="trim-input"
                placeholder="0:00"
                value={settings.trimStart ? formatTime(settings.trimStart) : ""}
                on:change={(e) => update("trimStart", parseTime(e.target.value))}
              />
              <span class="trim-sep">to</span>
              <input
                type="text"
                class="trim-input"
                placeholder="end"
                value={settings.trimEnd ? formatTime(settings.trimEnd) : ""}
                on:change={(e) => update("trimEnd", parseTime(e.target.value))}
              />
            </div>
          </div>
        {/if}

        {#if showBitrate}
          <div class="opt">
            <label>Bitrate</label>
            <select
              value={settings.bitrate || ""}
              on:change={(e) => update("bitrate", e.target.value || null)}
            >
              {#each bitrateOptions as b}
                <option value={b.value || ""}>{b.label}</option>
              {/each}
            </select>
          </div>
        {/if}

        {#if showPreset}
          <div class="opt">
            <label>Encoder preset</label>
            <select
              value={settings.preset || "medium"}
              on:change={(e) => update("preset", e.target.value)}
            >
              {#each PRESETS as p}
                <option value={p}>{p}</option>
              {/each}
            </select>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<script context="module">
  function formatTime(sec) {
    if (!sec && sec !== 0) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function parseTime(str) {
    if (!str || !str.trim()) return null;
    const parts = str.trim().split(":");
    if (parts.length === 1) return parseFloat(parts[0]) || null;
    if (parts.length === 2) return (parseInt(parts[0]) || 0) * 60 + (parseFloat(parts[1]) || 0);
    if (parts.length === 3) return (parseInt(parts[0]) || 0) * 3600 + (parseInt(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0);
    return null;
  }
</script>

<style>
  .advanced {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    animation: fadeUp 0.35s ease-out;
  }

  .toggle-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 14px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 600;
    text-align: left;
  }

  .toggle-head:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .chevron {
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .options {
    padding: 4px 14px 14px;
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

  .opt label {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-weight: 500;
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

  /* Trim */
  .trim-row {
    align-items: center;
  }

  .trim-inputs {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
  }

  .trim-input {
    width: 70px;
    padding: 6px 8px;
    background: var(--bg-input);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    font-family: inherit;
    font-size: 0.78rem;
    text-align: center;
    outline: none;
  }

  .trim-input:focus { border-color: var(--accent-dim); }
  .trim-input::placeholder { color: var(--text-muted); }

  .trim-sep {
    font-size: 0.72rem;
    color: var(--text-muted);
  }
</style>
