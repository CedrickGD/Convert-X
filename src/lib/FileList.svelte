<script>
  import { open } from "@tauri-apps/plugin-dialog";

  export let files = [];
  export let view = "ready"; // ready | converting | done
  export let onRemoveFile;
  export let onAddFiles;

  function fmtSize(bytes) {
    if (!bytes) return "";
    const u = ["B", "KB", "MB", "GB"];
    let s = bytes, i = 0;
    while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
    return `${s.toFixed(1)} ${u[i]}`;
  }

  function typeIcon(type) {
    if (type === "video") return "film";
    if (type === "audio") return "music";
    return "image";
  }

  async function handleAddMore() {
    const selected = await open({
      multiple: true,
      filters: [{
        name: "All Supported",
        extensions: [
          "png","jpg","jpeg","gif","bmp","tiff","tif","ico","webp",
          "mp4","mkv","avi","webm","mov","flv","wmv","ts","m4v",
          "mp3","wav","flac","ogg","aac","wma","m4a","opus",
        ],
      }],
    });
    if (selected && selected.length > 0) {
      onAddFiles(Array.isArray(selected) ? selected : [selected]);
    }
  }
</script>

<div class="file-list">
  <div class="list-header">
    <span class="count">{files.length} file{files.length !== 1 ? "s" : ""}</span>
    {#if view === "ready"}
      <button class="add-btn" on:click={handleAddMore}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add
      </button>
    {/if}
  </div>

  <div class="list-body">
    {#each files as file (file.id)}
      <div class="file-row" class:done={file.status === "done"} class:error={file.status === "error" || file.status === "skipped"}>
        <div class="type-dot {typeIcon(file.detectedType)}"></div>

        <div class="file-info">
          <span class="fname">{file.metadata?.fileName || file.filePath.split(/[/\\]/).pop()}</span>
          {#if file.status === "converting"}
            <div class="inline-progress">
              <div class="inline-track">
                <div class="inline-fill" style="width: {file.progress}%"></div>
              </div>
              <span class="inline-pct">{Math.round(file.progress)}%</span>
            </div>
          {:else if file.status === "done"}
            <span class="status-text done-text">{fmtSize(file.outputSize)}</span>
          {:else if file.status === "error"}
            <span class="status-text error-text">Failed</span>
          {:else if file.status === "skipped"}
            <span class="status-text skip-text">Skipped</span>
          {:else if file.status === "detecting"}
            <span class="status-text detect-text">Detecting...</span>
          {:else if file.status === "queued"}
            <span class="status-text queue-text">Queued</span>
          {:else}
            <span class="status-text size-text">{fmtSize(file.metadata?.size)}</span>
          {/if}
        </div>

        {#if file.status === "done"}
          <div class="status-icon done-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        {:else if file.status === "error"}
          <div class="status-icon error-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </div>
        {:else if view === "ready" && onRemoveFile}
          <button class="remove-btn" on:click={() => onRemoveFile(file.id)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .file-list {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    animation: fadeUp 0.3s ease-out;
  }

  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }

  .count {
    font-size: 0.72rem;
    color: var(--text-muted);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .add-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    background: transparent;
    color: var(--accent);
    font-size: 0.72rem;
    font-weight: 600;
    border-radius: var(--radius-xs);
    border: 1px solid var(--border);
  }

  .add-btn:hover {
    background: var(--accent-subtle);
    border-color: var(--accent-dim);
  }

  .list-body {
    max-height: 180px;
    overflow-y: auto;
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border);
    transition: background var(--transition-fast);
  }

  .file-row:last-child { border-bottom: none; }
  .file-row:hover { background: var(--bg-hover); }

  .type-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .type-dot.film { background: #60a5fa; }
  .type-dot.music { background: #c084fc; }
  .type-dot.image { background: #34d399; }

  .file-info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .fname {
    font-size: 0.78rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .status-text {
    font-size: 0.68rem;
    flex-shrink: 0;
    font-weight: 500;
  }

  .done-text { color: var(--success); }
  .error-text { color: var(--error); }
  .skip-text { color: var(--text-muted); }
  .detect-text { color: var(--text-muted); animation: pulse 1.5s infinite; }
  .queue-text { color: var(--text-muted); }
  .size-text { color: var(--text-muted); }

  /* Inline progress */
  .inline-progress {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    width: 100px;
  }

  .inline-track {
    flex: 1;
    height: 3px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .inline-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .inline-pct {
    font-size: 0.68rem;
    color: var(--accent);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    width: 28px;
    text-align: right;
  }

  /* Status icons */
  .status-icon {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .done-icon { color: var(--success); }
  .error-icon { color: var(--error); }

  .remove-btn {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--text-muted);
    border-radius: 4px;
    flex-shrink: 0;
    opacity: 0;
  }

  .file-row:hover .remove-btn { opacity: 1; }
  .remove-btn:hover { color: var(--error); background: var(--error-dim); }
</style>
