<script>
  import { onMount } from "svelte";
  import { fetchLatestDesktopRelease, pickWindowsAssets, formatSize, RELEASES_URL } from "../lib/github.js";

  export let variant = "card"; // "card" | "inline"

  let release = null;
  let loading = true;

  onMount(async () => {
    // The monorepo's /releases/latest mixes android (v*) and desktop
    // (desktop-v*) tags — this promo must never hand a web visitor an APK
    // release, so pick the newest desktop-v* release specifically.
    release = await fetchLatestDesktopRelease();
    loading = false;
  });

  $: ({ msi, exe } = pickWindowsAssets(release));
  $: primary = msi || exe || null;
</script>

<div class="desktop-download" class:inline={variant === "inline"}>
  <div class="copy">
    <div class="title">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
      Get the Desktop App
    </div>
    <p class="reason">
      Runs locally with bundled FFmpeg — no upload, no in-browser transcode. Conversions are typically much faster than the web version.
    </p>
  </div>

  <div class="actions">
    {#if loading}
      <span class="muted">Checking latest version…</span>
    {:else if primary}
      <a class="btn primary" href={primary.downloadUrl} download>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Download for Windows
      </a>
      <div class="meta">
        {#if release?.version}<span>v{release.version}</span>{:else if release?.tagName}<span>{release.tagName}</span>{/if}
        {#if primary.size}<span>· {formatSize(primary.size)}</span>{/if}
        {#if msi && exe}
          <span>·</span>
          <a class="alt" href={(primary === msi ? exe : msi).downloadUrl} download>
            {primary === msi ? "portable .exe" : "installer .msi"}
          </a>
        {/if}
      </div>
    {:else}
      <a class="btn primary" href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
        View Releases
      </a>
    {/if}
  </div>
</div>

<style>
  .desktop-download {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .desktop-download.inline {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 10px 14px;
  }

  .copy { display: flex; flex-direction: column; gap: 4px; }

  .title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .reason {
    font-size: 0.78rem;
    color: var(--text-secondary);
    line-height: 1.4;
    margin: 0;
  }

  .actions {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .desktop-download.inline .actions {
    align-items: flex-end;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: var(--radius-sm);
    font-weight: 600;
    font-size: 0.82rem;
    letter-spacing: -0.01em;
    text-decoration: none;
  }

  .btn.primary {
    background: var(--accent);
    color: var(--btn-primary-text);
  }

  .btn.primary:hover {
    background: var(--accent-hover);
    box-shadow: 0 0 18px var(--accent-glow), 0 4px 10px rgba(0, 0, 0, 0.25);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .meta .alt {
    color: var(--text-secondary);
    text-decoration: underline;
    text-decoration-color: var(--border);
    text-underline-offset: 2px;
  }

  .meta .alt:hover { color: var(--accent); }

  .muted { color: var(--text-muted); font-size: 0.8rem; }
</style>
