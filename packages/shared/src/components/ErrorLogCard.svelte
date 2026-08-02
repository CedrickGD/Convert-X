<script>
  import { onMount } from "svelte";
  import { getErrorLog, clearErrorLog, subscribeErrorLog } from "../lib/errorLog.js";
  import { toast, confirmDialog } from "../lib/feedback.js";

  // Local error log viewer (Credits card). Field failures — probe,
  // download, crash — have no other diagnostic trail; this reads the
  // localStorage ring buffer back. Collapsed by default; the data never
  // leaves the device unless the user copies it. Web-safe and un-gated.

  let open = false;
  let entries = [];

  onMount(() => {
    entries = getErrorLog();
    return subscribeErrorLog(() => {
      entries = getErrorLog();
    });
  });

  $: shown = entries.slice(0, 20);

  async function onCopy() {
    const text = entries
      .map(
        (e) =>
          `${new Date(e.at).toISOString()} [${e.scope}] ${e.message}${e.detail ? ` — ${e.detail}` : ""}`
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text || "(empty)");
      toast("Error log copied", "success");
    } catch {
      toast("Couldn't access the clipboard", "error");
    }
  }

  async function onClear() {
    const ok = await confirmDialog({
      title: "Clear the error log?",
      message: "All recorded entries are removed. This can't be undone.",
      confirmLabel: "Clear",
      danger: true,
    });
    if (!ok) return;
    clearErrorLog();
  }
</script>

<section class="card">
  <button class="head" on:click={() => (open = !open)}>
    <div class="head-copy">
      <h2>Error log</h2>
      <span class="sub">
        {entries.length === 0
          ? "No recorded errors."
          : `${entries.length} recorded — stays on this device.`}
      </span>
    </div>
    <svg
      class="chev"
      class:open
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      aria-hidden="true"
    ><polyline points="9 18 15 12 9 6" /></svg>
  </button>

  {#if open}
    <div class="body">
      {#each shown as e, i (`${e.at}-${i}`)}
        <div class="entry" class:first={i === 0}>
          <div class="meta">{new Date(e.at).toLocaleString()} · {e.scope}</div>
          <div class="msg">{e.message}</div>
          {#if e.detail}
            <div class="detail">{e.detail}</div>
          {/if}
        </div>
      {/each}

      {#if entries.length > 0}
        <div class="log-actions">
          <button class="mini-btn" on:click={onCopy}>Copy all</button>
          <button class="mini-btn danger" on:click={onClear}>Clear</button>
        </div>
      {:else}
        <p class="empty">Nothing here — errors from probes, downloads and crashes land in this log.</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .card {
    padding: 14px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    background: transparent;
    text-align: left;
    padding: 0;
    cursor: pointer;
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
    font-size: 0.82rem;
    color: var(--text-secondary);
  }

  .chev {
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform var(--transition-fast);
  }

  .chev.open { transform: rotate(90deg); }

  .body {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .entry {
    padding-top: 8px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .entry.first { border-top: none; padding-top: 0; }

  .meta {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .msg {
    font-size: 0.82rem;
    color: var(--text-primary);
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .detail {
    font-size: 0.76rem;
    color: var(--text-secondary);
    word-break: break-all;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .log-actions {
    display: flex;
    gap: 8px;
    padding-top: 6px;
  }

  .mini-btn {
    padding: 6px 14px;
    font-size: 0.78rem;
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

  .empty {
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0;
    padding-top: 6px;
  }
</style>
