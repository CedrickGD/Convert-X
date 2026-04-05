<script>
  import { open } from "@tauri-apps/plugin-dialog";

  export let onFilesDrop;
  export let mode = "convert";

  let isDragging = false;

  const IMAGE_EXTENSIONS = ["png","jpg","jpeg","gif","bmp","tiff","tif","ico","webp"];
  const ALL_EXTENSIONS = [
    ...IMAGE_EXTENSIONS,
    "mp4","mkv","avi","webm","mov","flv","wmv","ts","m4v",
    "mp3","wav","flac","ogg","aac","wma","m4a","opus",
  ];

  async function handleBrowse() {
    const isResize = mode === "resize";
    const selected = await open({
      multiple: true,
      filters: [{
        name: isResize ? "Images" : "All Supported",
        extensions: isResize ? IMAGE_EXTENSIONS : ALL_EXTENSIONS,
      }],
    });
    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      if (paths.length > 0) onFilesDrop(paths);
    }
  }

  function handleDragEnter() { isDragging = true; }
  function handleDragLeave() { isDragging = false; }
  function handleDrop() { isDragging = false; }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="dropzone"
  class:active={isDragging}
  on:click={handleBrowse}
  on:dragenter|preventDefault={handleDragEnter}
  on:dragleave|preventDefault={handleDragLeave}
  on:dragover|preventDefault={() => {}}
  on:drop|preventDefault={handleDrop}
  role="button"
  tabindex="0"
>
  <div class="inner">
    <div class="icon-wrap">
      {#if mode === "resize"}
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="15 3 21 3 21 9"/>
          <polyline points="9 21 3 21 3 15"/>
          <line x1="21" y1="3" x2="14" y2="10"/>
          <line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
      {:else}
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      {/if}
    </div>
    {#if mode === "resize"}
      <p class="title">Drop images to resize</p>
      <p class="subtitle">or click to browse &middot; PNG, JPG, WebP, BMP, TIFF</p>
      <div class="chips">
        <span class="chip">Image</span>
      </div>
    {:else}
      <p class="title">Drop files to convert</p>
      <p class="subtitle">or click to browse &middot; multiple files supported</p>
      <div class="chips">
        <span class="chip">Video</span>
        <span class="chip">Audio</span>
        <span class="chip">Image</span>
      </div>
    {/if}
  </div>
</div>

<style>
  .dropzone {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1.5px dashed var(--border-hover);
    border-radius: var(--radius);
    background: var(--bg-secondary);
    cursor: pointer;
    transition: all var(--transition);
    min-height: 300px;
    position: relative;
    overflow: hidden;
  }

  .dropzone::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 50% 50%, var(--accent-subtle), transparent 70%);
    opacity: 0;
    transition: opacity var(--transition);
  }

  .dropzone:hover::before,
  .dropzone.active::before {
    opacity: 1;
  }

  .dropzone:hover,
  .dropzone.active {
    border-color: var(--accent-dim);
  }

  .inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    position: relative;
    z-index: 1;
  }

  .icon-wrap {
    color: var(--text-muted);
    transition: all var(--transition);
  }

  .dropzone:hover .icon-wrap {
    color: var(--accent);
    transform: translateY(-3px);
  }

  .title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .subtitle {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin-top: -4px;
  }

  .chips {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }

  .chip {
    padding: 3px 10px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 100px;
    font-size: 0.68rem;
    color: var(--text-muted);
    font-weight: 500;
  }
</style>
