<script>
  export let fileTypes = new Set();
  export let selectedFormat;
  export let onFormatSelect;
  export let sourceFormats = new Set();
  export let hasEdits = false;

  const FORMATS = {
    video: ["mp4", "mkv", "avi", "webm", "mov", "gif", "flv", "wmv", "ts"],
    image: ["png", "jpg", "webp", "bmp", "tiff", "ico", "gif"],
    audio: ["mp3", "wav", "flac", "ogg", "aac", "wma", "m4a", "opus"],
  };

  // Build sections based on present file types
  $: sections = (() => {
    const s = [];
    if (fileTypes.has("video")) s.push({ label: "Video", formats: FORMATS.video });
    if (fileTypes.has("image")) s.push({ label: "Image", formats: FORMATS.image });
    // Video sources can also target audio formats (track extraction).
    if (fileTypes.has("audio") || fileTypes.has("video")) s.push({ label: "Audio", formats: FORMATS.audio });
    // If only one type, don't show the label
    return s;
  })();

  $: showLabels = sections.length > 1;

  function isMuted(fmt) {
    return sourceFormats && sourceFormats.has(fmt) && !hasEdits;
  }
</script>

<div class="picker">
  <span class="top-label">Format</span>

  {#each sections as section, si}
    {#if showLabels}
      <span class="section-label">{section.label}</span>
    {/if}
    <div class="grid">
      {#each section.formats as fmt, i}
        {@const muted = isMuted(fmt)}
        <button
          class="fmt"
          class:selected={selectedFormat === fmt}
          class:muted
          on:click={() => onFormatSelect(fmt)}
          style="animation-delay: {(si * 6 + i) * 25}ms"
          title={muted ? "Same format as source — change a setting (trim, quality, bitrate, …) to re-encode." : ""}
        >
          {fmt.toUpperCase()}
        </button>
      {/each}
    </div>
  {/each}
</div>

<style>
  .picker {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
    animation: fadeUp 0.3s ease-out;
  }

  .top-label {
    display: block;
    font-size: 0.68rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    margin-bottom: 10px;
  }

  .section-label {
    display: block;
    font-size: 0.65rem;
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 6px;
    margin-top: 8px;
  }

  .section-label:first-of-type { margin-top: 0; }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(60px, 1fr));
    gap: 5px;
    margin-bottom: 4px;
  }

  .fmt {
    padding: 8px 4px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-secondary);
    font-weight: 600;
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    animation: fadeUp 0.3s ease-out both;
  }

  .fmt:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border-hover);
    transform: translateY(-1px);
  }

  .fmt.selected {
    background: var(--accent);
    color: var(--btn-primary-text);
    border-color: var(--accent);
    font-weight: 700;
    box-shadow: 0 0 16px var(--accent-glow);
  }

  .fmt.selected:hover {
    background: var(--accent-hover);
  }

  .fmt.muted {
    opacity: 0.45;
    border-style: dashed;
  }

  .fmt.muted:hover {
    opacity: 0.7;
  }

  .fmt.muted.selected {
    opacity: 0.85;
  }
</style>
