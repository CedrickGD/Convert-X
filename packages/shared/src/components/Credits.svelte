<script>
  import { onMount } from "svelte";
  import DesktopDownload from "./DesktopDownload.svelte";
  import WebVersionLink from "./WebVersionLink.svelte";
  import {
    fetchLatestRelease,
    fetchLatestDesktopRelease,
    isNewerVersion,
    pickWindowsAssets,
    formatSize,
    REPO_URL,
  } from "../lib/github.js";
  import { getPlatform } from "../platform.js";

  const platform = getPlatform();
  const isWeb = platform.platformType === "web";
  const isDesktop = platform.platformType === "desktop";

  // APKs live in the monorepo's GitHub releases (v* tags).
  const ANDROID_URL = `${REPO_URL}/releases`;

  let version = "";

  // --- Desktop self-update (mirrors the Android one-click flow) ---
  let upState = "idle"; // idle | checking | available | downloading | uptodate | error
  let upPct = 0;
  let currentVersion = "";
  let latest = null;
  let latestAsset = null;

  async function checkDesktopUpdate(silent) {
    if (!isDesktop) return;
    if (!silent) upState = "checking";
    try {
      if (!currentVersion) currentVersion = await platform.getAppVersion();
      const rel = await fetchLatestDesktopRelease();
      if (rel && isNewerVersion(rel.version, currentVersion)) {
        const win = pickWindowsAssets(rel);
        latestAsset = win.msi || win.exe;
        latest = rel;
        upState = latestAsset ? "available" : silent ? "idle" : "error";
      } else {
        upState = silent ? "idle" : "uptodate";
      }
    } catch {
      upState = silent ? "idle" : "error";
    }
  }

  async function installDesktopUpdate() {
    if (!latestAsset) return;
    upState = "downloading";
    upPct = 0;
    const stop = platform.onUpdateProgress((p) => (upPct = p));
    try {
      const path = await platform.downloadInstaller(latestAsset.downloadUrl);
      await platform.launchInstaller(path); // app quits here so the MSI can replace it
    } catch {
      upState = "error";
    } finally {
      stop?.();
    }
  }

  function onUpdateButton() {
    if (upState === "available") installDesktopUpdate();
    else checkDesktopUpdate(false);
  }

  onMount(async () => {
    const r = await fetchLatestRelease();
    if (r?.tagName) version = r.tagName;
    if (isDesktop) checkDesktopUpdate(true); // silent auto-check
  });

  const oss = [
    { name: "Tauri", url: "https://tauri.app", role: "desktop runtime" },
    { name: "Svelte", url: "https://svelte.dev", role: "UI framework" },
    { name: "Vite", url: "https://vitejs.dev", role: "build tool" },
    { name: "FFmpeg", url: "https://ffmpeg.org", role: "media encoding" },
    { name: "ffmpeg.wasm", url: "https://ffmpegwasm.netlify.app", role: "in-browser transcode" },
  ];
</script>

<div class="credits">
  <section class="card author">
    <h2>Built by</h2>
    <a class="author-link" href="https://github.com/CedrickGD" target="_blank" rel="noopener noreferrer">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.68 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.15 1.17.91-.25 1.89-.38 2.86-.38s1.95.13 2.86.38c2.18-1.48 3.14-1.17 3.14-1.17.62 1.58.23 2.75.11 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.25 5.65.41.36.78 1.06.78 2.13v3.16c0 .31.21.67.8.55 4.56-1.52 7.85-5.83 7.85-10.91C23.5 5.65 18.35.5 12 .5z"/></svg>
      <div>
        <div class="name">CedrickGD</div>
        <div class="handle">@CedrickGD on GitHub</div>
      </div>
    </a>
  </section>

  {#if isDesktop}
    <section class="card update">
      <h2>{upState === "available" ? "Update available" : "App update"}</h2>
      <div class="update-row">
        <div class="update-info">
          <div class="update-sub">
            {#if upState === "checking"}Checking GitHub…
            {:else if upState === "downloading"}Downloading… {upPct}%
            {:else if upState === "available"}v{latest.version}{latestAsset?.size ? ` · ${formatSize(latestAsset.size)}` : ""}
            {:else if upState === "uptodate"}You have the latest version.
            {:else if upState === "error"}Couldn't check for updates.
            {:else}{currentVersion ? `Installed v${currentVersion}` : "Check for updates"}{/if}
          </div>
        </div>
        {#if upState !== "downloading"}
          <button
            class="update-btn"
            class:primary={upState === "available"}
            on:click={onUpdateButton}
            disabled={upState === "checking"}
          >
            {upState === "available" ? "Update now" : "Check"}
          </button>
        {/if}
      </div>
      {#if upState === "downloading"}
        <div class="progress"><div class="bar" style={`width:${upPct}%`}></div></div>
      {/if}
    </section>
  {/if}

  {#if isWeb}
    <DesktopDownload variant="card" />
  {:else}
    <WebVersionLink />
  {/if}

  <!-- Cross-link to the third surface (Android), shown on web + desktop -->
  <section class="card">
    <h2>Also on Android</h2>
    <a class="cross-link" href={ANDROID_URL} target="_blank" rel="noopener noreferrer">
      Download the Android APK
      <span aria-hidden="true">→</span>
    </a>
  </section>

  <section class="card">
    <h2>Open Source</h2>
    <p class="lead">Convert-X stands on the shoulders of these projects:</p>
    <ul class="oss">
      {#each oss as o}
        <li>
          <a href={o.url} target="_blank" rel="noopener noreferrer">{o.name}</a>
          <span class="role">{o.role}</span>
        </li>
      {/each}
    </ul>
  </section>

  <section class="card">
    <h2>Source</h2>
    <ul class="links">
      <li><a href={REPO_URL} target="_blank" rel="noopener noreferrer">Repository on GitHub</a></li>
      <li><a href={`${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer">All releases{version ? ` · latest ${version}` : ""}</a></li>
      <li><a href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer">Issues &amp; feedback</a></li>
    </ul>
  </section>
</div>

<style>
  .credits {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 20px;
    animation: fadeUp 0.35s ease-out;
  }

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

  .author-link {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-primary);
    text-decoration: none;
  }

  .author-link:hover .name { color: var(--accent); }

  .name {
    font-size: 1rem;
    font-weight: 600;
    transition: color var(--transition-fast);
  }

  .handle {
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  /* Update card */
  .update-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .update-sub {
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .update-btn {
    flex-shrink: 0;
    padding: 7px 14px;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-elev, transparent);
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
  }

  .update-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .update-btn:disabled { opacity: 0.6; cursor: default; }

  .update-btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .update-btn.primary:hover { filter: brightness(1.08); color: #fff; }

  .progress {
    margin-top: 10px;
    height: 6px;
    background: var(--border);
    border-radius: 999px;
    overflow: hidden;
  }
  .bar {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s ease;
  }

  .cross-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-primary);
    text-decoration: none;
  }
  .cross-link:hover { color: var(--accent); }

  .lead {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin: 0 0 10px 0;
  }

  .oss, .links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .oss li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.85rem;
  }

  .oss li a, .links li a {
    color: var(--text-primary);
    text-decoration: none;
    font-weight: 500;
  }

  .oss li a:hover, .links li a:hover { color: var(--accent); }

  .role {
    font-size: 0.74rem;
    color: var(--text-muted);
  }

  .links li { font-size: 0.85rem; }
</style>
