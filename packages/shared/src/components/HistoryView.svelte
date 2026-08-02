<script>
  import { onMount } from "svelte";
  import { getPlatform } from "../platform.js";
  import {
    getHistory,
    removeHistoryEntry,
    clearHistory,
    subscribeHistory,
  } from "../lib/history.js";
  import { toast, confirmDialog } from "../lib/feedback.js";

  // Download history tab. Finished downloads used to vanish on reset —
  // this reads the persisted index so outputs stay reachable (open file /
  // open folder) until deleted. Dead files are pruned lazily by
  // history.js itself via platform.fileExists. Desktop-only: the tab is
  // gated in Navbar, and open/folder actions are feature-detected anyway.

  const platform = getPlatform();
  const canOpenFile = typeof platform.openFile === "function";
  const canOpenFolder = typeof platform.openInFolder === "function";

  let entries = [];
  let loaded = false;
  let refreshing = false;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      entries = await getHistory();
    } finally {
      refreshing = false;
      loaded = true;
    }
  }

  onMount(() => {
    refresh();
    return subscribeHistory(() => {
      refresh();
    });
  });

  function fileName(path) {
    if (!path) return "";
    return String(path).split(/[/\\]/).pop();
  }

  async function openFile(e) {
    try {
      await platform.openFile(e.outputPath);
    } catch {
      toast("Couldn't open the file — it may have been moved.", "error");
    }
  }

  async function openFolder(e) {
    try {
      await platform.openInFolder(e.outputPath);
    } catch {
      toast("Couldn't open the folder.", "error");
    }
  }

  async function onRemove(e) {
    const ok = await confirmDialog({
      title: "Remove from history?",
      message: `"${e.title}" is removed from the list. The downloaded file stays on disk.`,
      confirmLabel: "Remove",
    });
    if (!ok) return;
    removeHistoryEntry(e.id);
  }

  async function onClearAll() {
    const ok = await confirmDialog({
      title: "Clear download history?",
      message: "The whole list is removed. Downloaded files stay on disk.",
      confirmLabel: "Clear all",
      danger: true,
    });
    if (!ok) return;
    clearHistory();
  }
</script>

<div class="history animate-in">
  <div class="head">
    <div class="head-copy">
      <h2>Download history</h2>
      <span class="sub">
        {entries.length === 0
          ? "Finished downloads show up here."
          : `${entries.length} download${entries.length !== 1 ? "s" : ""} — entries whose file was deleted disappear automatically.`}
      </span>
    </div>
    {#if entries.length > 0}
      <button class="mini-btn danger" on:click={onClearAll}>Clear all</button>
    {/if}
  </div>

  {#if entries.length === 0}
    {#if loaded}
      <div class="empty">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <p>Nothing downloaded yet.</p>
        <p class="hint">Grab something from the Download tab and it lands here.</p>
      </div>
    {/if}
  {:else}
    <ul class="list">
      {#each entries as e (e.id)}
        <li class="row">
          <div class="row-copy">
            <div class="row-title" title={e.outputPath}>{e.title}</div>
            <div class="row-sub">
              {new Date(e.at).toLocaleString()}
              {#if e.mediaType}<span class="dot">·</span>{e.mediaType}{/if}
              {#if fileName(e.outputPath)}<span class="dot">·</span><span class="fname">{fileName(e.outputPath)}</span>{/if}
            </div>
          </div>
          <div class="row-actions">
            {#if canOpenFile}
              <button class="mini-btn" on:click={() => openFile(e)}>Open file</button>
            {/if}
            {#if canOpenFolder}
              <button class="mini-btn" on:click={() => openFolder(e)}>Open folder</button>
            {/if}
            <button class="icon-btn" title="Remove from history" aria-label="Remove from history" on:click={() => onRemove(e)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .history {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 20px;
  }

  .animate-in {
    animation: fadeUp 0.35s ease-out;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .head-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  h2 {
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 0;
  }

  .sub {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 48px 16px;
    color: var(--text-muted);
    text-align: center;
  }

  .empty p {
    margin: 0;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }

  .empty .hint {
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .row-copy {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .row-title {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row-sub {
    font-size: 0.74rem;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dot { margin: 0 4px; }

  .fname { color: var(--text-secondary); }

  .row-actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mini-btn {
    padding: 6px 12px;
    font-size: 0.76rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
  }

  .mini-btn:hover { background: var(--bg-hover); border-color: var(--border-hover); }

  .mini-btn.danger { color: var(--error); }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .icon-btn:hover {
    background: var(--bg-hover);
    color: var(--error);
  }
</style>
