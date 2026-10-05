<script>
  import { onMount } from "svelte";
  import { getPlatform } from "../platform.js";

  // Web-only "Access key" card for the self-hosted downloader behind the
  // Convert-X gateway. The key unlocks /v1/dl/* (yt-dlp on the NAS); the
  // Discord stealer never needs it. Renders nothing on a platform without
  // a key-capable gateway (desktop, or the TEMP-DEBUG web=1 harness).

  /** Called with `true` when the downloader is unlocked (a key is stored),
   *  `false` when the key is forgotten or rejected. */
  export let onChange = () => {};

  const platform = getPlatform();
  const gateway = typeof platform.gateway?.getKey === "function" ? platform.gateway : null;

  let hasKey = !!gateway?.getKey();
  let keyInput = "";
  let reveal = false;
  // idle | checking | ok | invalid | offline | rejected (a saved key that
  // stopped working)
  let status = hasKey ? "checking" : "idle";
  let busy = false;

  function notify(on) {
    try {
      onChange(on);
    } catch {
      // Parent callback failures must not break the card.
    }
  }

  async function recheck() {
    if (!gateway || busy) return;
    busy = true;
    status = "checking";
    try {
      const r = await gateway.check();
      if (r === "ok") {
        status = "ok";
      } else if (r === "invalid") {
        gateway.setKey(null);
        hasKey = false;
        status = "rejected";
        notify(false);
      } else if (r === "nokey") {
        hasKey = false;
        status = "idle";
        notify(false);
      } else {
        status = "offline";
      }
    } finally {
      busy = false;
    }
  }

  async function unlock() {
    const key = keyInput.trim();
    if (!gateway || !key || busy) return;
    busy = true;
    status = "checking";
    gateway.setKey(key);
    try {
      const r = await gateway.check();
      if (r === "invalid" || r === "nokey") {
        gateway.setKey(null);
        hasKey = false;
        status = "invalid";
        notify(false);
        return;
      }
      // 'offline' can't tell a good key from a bad one — keep it and let a
      // later Retry confirm it, rather than making the user paste it again.
      hasKey = true;
      keyInput = "";
      reveal = false;
      status = r === "ok" ? "ok" : "offline";
      notify(true);
    } finally {
      busy = false;
    }
  }

  function forget() {
    if (!gateway) return;
    gateway.setKey(null);
    hasKey = false;
    keyInput = "";
    status = "idle";
    notify(false);
  }

  onMount(() => {
    if (hasKey) recheck();
  });

  $: statusLine =
    status === "checking"
      ? "Talking to the downloader…"
      : status === "offline"
        ? "Couldn't reach the downloader to confirm it — try again in a bit."
        : "Online — paste a link above and hit Preview.";
</script>

{#if gateway}
  <section class="key-card" class:unlocked={hasKey}>
    {#if hasKey}
      <div class="row">
        <div class="icon-box" class:warn={status === "offline"} aria-hidden="true">
          {#if status === "checking"}
            <span class="spinner"></span>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
          {/if}
        </div>
        <div class="copy">
          <div class="title">
            {status === "ok" ? "Downloader unlocked" : status === "checking" ? "Checking your key…" : "Key saved"}
            <span class="dot" class:ok={status === "ok"} class:warn={status === "offline"} aria-hidden="true"></span>
          </div>
          <div class="sub" class:warn={status === "offline"} role="status">{statusLine}</div>
        </div>
        <div class="actions">
          {#if status === "offline"}
            <button type="button" class="ghost-btn" disabled={busy} on:click={recheck}>Retry</button>
          {/if}
          <button type="button" class="ghost-btn" disabled={busy} on:click={forget}>Forget key</button>
        </div>
      </div>
    {:else}
      <div class="row">
        <div class="icon-box" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <div class="copy">
          <div class="title">Access key</div>
          <div class="sub">
            Unlocks YouTube, X, Instagram and 1800+ more sites here in the browser.
            Discord stickers, emoji and GIFs work without one.
          </div>
        </div>
      </div>
      <form class="key-row" on:submit|preventDefault={unlock}>
        <div class="input-wrap">
          <input
            class="key-input"
            type={reveal ? "text" : "password"}
            placeholder="Paste your access key"
            value={keyInput}
            on:input={(e) => {
              keyInput = e.currentTarget.value;
              if (status === "invalid" || status === "rejected") status = "idle";
            }}
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            aria-label="Access key"
            disabled={busy}
          />
          <button
            type="button"
            class="reveal"
            on:click={() => (reveal = !reveal)}
            aria-label={reveal ? "Hide key" : "Show key"}
            title={reveal ? "Hide key" : "Show key"}
            disabled={busy}
          >
            {#if reveal}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
            {/if}
          </button>
        </div>
        <button type="submit" class="unlock-btn" disabled={busy || !keyInput.trim()}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
      {#if status === "invalid"}
        <div class="msg error" role="alert">That key didn't work — check it and try again.</div>
      {:else if status === "rejected"}
        <div class="msg error" role="alert">Your saved key stopped working — enter a new one.</div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .key-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    animation: fadeUp 0.3s ease-out;
  }

  .key-card.unlocked { border-color: var(--accent-border, var(--border)); }

  .row { display: flex; align-items: center; gap: 12px; min-width: 0; }

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
  .icon-box.warn { background: rgba(245, 158, 11, 0.12); color: var(--warning); }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: key-spin 0.8s linear infinite;
  }
  @keyframes key-spin { to { transform: rotate(360deg); } }

  .copy { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }

  .title {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
  .dot.ok { background: var(--success); box-shadow: 0 0 6px var(--success); }
  .dot.warn { background: var(--warning); }

  .sub { font-size: 0.76rem; color: var(--text-secondary); line-height: 1.45; word-break: break-word; }
  .sub.warn { color: var(--warning); }

  .actions { display: flex; gap: 6px; flex-shrink: 0; }

  .ghost-btn {
    padding: 6px 11px;
    font-size: 0.74rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .ghost-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  .ghost-btn:disabled { opacity: 0.5; cursor: default; }

  .key-row { display: flex; gap: 8px; }

  .input-wrap { position: relative; flex: 1; min-width: 0; display: flex; }

  .key-input {
    flex: 1;
    min-width: 0;
    padding: 9px 36px 9px 11px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8rem;
    outline: none;
    user-select: text;
    transition: border-color var(--transition-fast);
  }
  .key-input:focus { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-glow); }
  .key-input:disabled { opacity: 0.6; }

  .reveal {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--text-muted);
  }
  .reveal:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
  .reveal:active:not(:disabled) { transform: translateY(-50%) scale(0.95); }

  .unlock-btn {
    flex-shrink: 0;
    padding: 9px 18px;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    background: var(--accent);
    color: var(--btn-primary-text);
  }
  .unlock-btn:hover:not(:disabled) { background: var(--accent-hover); box-shadow: 0 0 14px var(--accent-glow); }
  .unlock-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  .msg { font-size: 0.74rem; line-height: 1.4; }
  .msg.error { color: var(--error); }

  @media (max-width: 420px) {
    .row { flex-wrap: wrap; }
    .actions { width: 100%; justify-content: flex-end; }
  }
</style>
