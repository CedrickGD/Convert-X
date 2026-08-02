<script>
  import { getPlatform } from "../platform.js";

  export let files = [];
  export let onStartOver;
  export let actionLabel = "converted";

  $: doneFiles = files.filter((f) => f.status === "done");
  $: errorFiles = files.filter((f) => f.status === "error");
  $: totalSize = doneFiles.reduce((sum, f) => sum + (f.outputSize || 0), 0);
  $: isWeb = getPlatform().platformType === "web";
  // A run where nothing succeeded must not celebrate with a checkmark.
  $: allFailed = doneFiles.length === 0 && errorFiles.length > 0;
  $: firstError = errorFiles.length > 0 ? errorFiles[0].error || "" : "";

  function fmtSize(bytes) {
    if (!bytes) return "0 B";
    const u = ["B", "KB", "MB", "GB"];
    let s = bytes, i = 0;
    while (s >= 1024 && i < u.length - 1) { s /= 1024; i++; }
    return `${s.toFixed(1)} ${u[i]}`;
  }

  function fileName(path) {
    return path ? path.split(/[/\\]/).pop() : "";
  }

  async function openFile(path) {
    try { await getPlatform().openFile(path); } catch (_) {}
  }

  async function openFolder(path) {
    try { await getPlatform().openInFolder(path); } catch (_) {}
  }

  async function downloadFile(file) {
    try { await getPlatform().saveFile(file.outputBlob, fileName(file.outputPath)); } catch (_) {}
  }
</script>

<div class="panel">
  <div class="check-ring" class:failed={allFailed}>
    {#if allFailed}
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    {:else}
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>
    {/if}
  </div>

  <h2>
    {#if allFailed}
      Nothing {actionLabel}
    {:else if doneFiles.length === 1}
      Done
    {:else}
      {doneFiles.length} files {actionLabel}
    {/if}
  </h2>

  {#if errorFiles.length > 0}
    <p class="error-note">{errorFiles.length} file{errorFiles.length > 1 ? "s" : ""} failed</p>
    {#if firstError}
      <p class="error-detail">{firstError}</p>
    {/if}
  {/if}

  {#if doneFiles.length > 0}
    <p class="total-size">Total: {fmtSize(totalSize)}</p>
  {/if}

  {#if doneFiles.length > 0}
  <div class="results-list">
    {#each doneFiles as file}
      <div class="result-row">
        <span class="result-name">{fileName(file.outputPath)}</span>
        <span class="result-size">{fmtSize(file.outputSize)}</span>
        {#if isWeb}
          <button class="icon-btn" on:click={() => downloadFile(file)} title="Download">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
        {:else}
          <button class="icon-btn" on:click={() => openFile(file.outputPath)} title="Open file">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </button>
          <button class="icon-btn" on:click={() => openFolder(file.outputPath)} title="Show in folder">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </button>
        {/if}
      </div>
    {/each}
  </div>
  {/if}

  <button class="again-btn" on:click={onStartOver}>
    {actionLabel === "resized" ? "Resize more images" : "Convert more files"}
  </button>
</div>

<style>
  .panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    animation: fadeUp 0.4s ease-out;
  }

  .check-ring {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: var(--accent-glow);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    animation: scaleIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  @keyframes scaleIn {
    from { transform: scale(0); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }

  .check-ring.failed {
    background: var(--error-dim, rgba(239, 68, 68, 0.1));
    color: var(--error);
  }

  h2 { font-size: 1.15rem; font-weight: 700; letter-spacing: -0.02em; }

  .error-note { font-size: 0.78rem; color: var(--error); }

  .error-detail {
    font-size: 0.72rem;
    color: var(--text-muted);
    max-width: 420px;
    text-align: center;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .total-size { font-size: 0.78rem; color: var(--text-muted); }

  .results-list {
    width: 100%;
    max-width: 420px;
    max-height: 200px;
    overflow-y: auto;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-top: 4px;
  }

  .result-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }

  .result-row:last-child { border-bottom: none; }

  .result-name {
    flex: 1;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .result-size {
    font-size: 0.68rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .icon-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--text-muted);
    border-radius: var(--radius-xs);
    flex-shrink: 0;
  }

  .icon-btn:hover {
    color: var(--accent);
    background: var(--accent-subtle);
  }

  .again-btn {
    margin-top: 8px;
    padding: 10px 24px;
    background: var(--accent);
    color: var(--btn-primary-text);
    font-weight: 600;
    font-size: 0.85rem;
    border-radius: var(--radius-sm);
  }

  .again-btn:hover {
    background: var(--accent-hover);
    box-shadow: 0 0 20px var(--accent-glow);
  }
</style>
