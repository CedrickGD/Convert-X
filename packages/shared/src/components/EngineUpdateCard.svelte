<script>
  import { updateYtDlpDeduped } from "../lib/downloadQueue.js";

  // yt-dlp engine refresh (Credits card). Extractors rot when sites change
  // their APIs — this re-pulls the latest yt-dlp on demand. The monthly
  // boot check already runs silently; the button is for re-running after a
  // future site breaks. Desktop-gated by the parent (platform.updateYtdlp
  // presence); updateYtDlpDeduped shares its in-flight promise with the
  // boot check so a click during it can't double-download.

  let state = "idle"; // idle | updating | success | error
  let message = "";

  async function onUpdate() {
    if (state === "updating") return;
    state = "updating";
    message = "";
    const result = await updateYtDlpDeduped();
    if (result.ok) {
      // Tell the user what actually happened — "Updated." would be a lie
      // when the engine skipped the download.
      const version = result.version ? ` (${result.version})` : "";
      message =
        result.status === "ALREADY_UP_TO_DATE"
          ? `Already up to date${version}.`
          : `Updated${version}. Try the failing URL again.`;
      state = "success";
    } else {
      message = result.error ?? "Update failed";
      state = "error";
    }
  }

  $: subline =
    state === "updating" ? "Fetching latest extractors…" :
    state === "success" || state === "error" ? message :
    "Refresh if a site (Instagram, TikTok…) stopped working.";
</script>

<section class="card">
  <h2>Download engine</h2>
  <div class="row">
    <div class="icon-box" aria-hidden="true">
      {#if state === "updating"}
        <span class="spinner"></span>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      {/if}
    </div>
    <div class="copy">
      <div class="title">yt-dlp engine</div>
      <div class="sub" class:error={state === "error"}>{subline}</div>
    </div>
    <button
      class="update-btn"
      class:done={state === "success"}
      disabled={state === "updating"}
      on:click={onUpdate}
    >
      {state === "success" ? "Done" : "Update"}
    </button>
  </div>
</section>

<style>
  .card {
    padding: 14px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  h2 {
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 0 0 10px 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .icon-box {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: var(--radius-sm);
    background: var(--accent-glow);
    color: var(--accent);
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: engine-spin 0.8s linear infinite;
  }

  @keyframes engine-spin { to { transform: rotate(360deg); } }

  .copy {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .sub {
    font-size: 0.78rem;
    color: var(--text-secondary);
    word-break: break-word;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .sub.error { color: var(--error); }

  .update-btn {
    flex-shrink: 0;
    padding: 7px 14px;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: var(--accent);
    color: var(--btn-primary-text);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .update-btn:hover:not(:disabled) { background: var(--accent-hover); }
  .update-btn:disabled { opacity: 0.6; cursor: default; }

  .update-btn.done {
    background: transparent;
    border-color: var(--border);
    color: var(--text-secondary);
  }
  .update-btn.done:hover:not(:disabled) { background: var(--bg-hover); }
</style>
