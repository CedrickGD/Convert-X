<script>
  import { onMount } from "svelte";
  import { getPlatform } from "../platform.js";
  import { LOGIN_PLATFORMS, LOGIN_USER_AGENT } from "../lib/loginPlatforms.js";
  import {
    hasCookiesForDomain,
    mergePlatformCookies,
    removePlatformCookies,
    importCookiesText,
  } from "../lib/cookies.js";
  import {
    checkInstagramSession,
    invalidateInstagramSessionCache,
  } from "../lib/instagramStories.js";
  import { toast, confirmDialog } from "../lib/feedback.js";
  import { logError } from "../lib/errorLog.js";
  import { loadJson, saveJson } from "../lib/storage.js";

  // Platform-logins Credits card. Sign in inside a dedicated login window;
  // the harvested cookies are merged into the single Netscape cookies.txt
  // that yt-dlp and the JS probers read. Rendered only on desktop when the
  // adapter can open a login window (gated by the parent).

  const platform = getPlatform();
  const canLogin = typeof platform.openLoginWindow === "function";
  const canImport =
    typeof platform.pickFiles === "function" && typeof platform.readFileBinary === "function";

  const CONNECTED_KEY = "convertx.connectedPlatforms.v1";

  let open = false;
  let connected = [];
  let busyKey = null;
  let importing = false;
  let error = "";
  // Is the saved Instagram session still accepted by the API? Without
  // this, a lapsed login only surfaces as a failed download later.
  let igSession = "unknown"; // ok | expired | unknown

  function readConnected() {
    const raw = loadJson(CONNECTED_KEY, []);
    return Array.isArray(raw) ? raw.filter((k) => typeof k === "string") : [];
  }

  function setConnected(list) {
    connected = list;
    saveJson(CONNECTED_KEY, list);
  }

  /**
   * Hydrate-validate the persisted "Connected" flags against the canonical
   * cookies file: a platform only counts as connected while cookies.txt
   * still holds its domain. Stale flags (file replaced/deleted outside the
   * card) are cleared rather than shown as a false "Connected". An
   * unanswerable check keeps the flag — a transient read failure must not
   * log everyone out.
   */
  async function validateConnected() {
    const stored = readConnected();
    const checked = await Promise.all(
      stored.map(async (key) => {
        const p = LOGIN_PLATFORMS.find((x) => x.key === key);
        if (!p) return null;
        try {
          return (await hasCookiesForDomain(p.cookieDomain)) ? key : null;
        } catch {
          return key;
        }
      })
    );
    const valid = checked.filter((k) => k !== null);
    if (valid.length !== stored.length) saveJson(CONNECTED_KEY, valid);
    connected = valid;
  }

  async function refreshIgSession() {
    if (!connected.includes("instagram")) {
      igSession = "unknown";
      return;
    }
    try {
      igSession = await checkInstagramSession();
    } catch {
      igSession = "unknown";
    }
  }

  async function revalidate() {
    await validateConnected();
    await refreshIgSession();
  }

  onMount(() => {
    revalidate();
  });

  function toggleOpen() {
    open = !open;
    // Re-check on expand: cookies may have changed since (import in the
    // Advanced field, expired session) — checkInstagramSession memoizes
    // for 15 min so this stays cheap.
    if (open) revalidate();
  }

  async function onLogin(p) {
    if (busyKey || !canLogin) return;
    error = "";
    busyKey = p.key;
    try {
      const res = await platform.openLoginWindow({
        platformKey: p.key,
        loginUrl: p.loginUrl,
        cookieOrigins: [p.cookieOrigin],
        requiredCookies: p.requiredCookies,
        userAgent: LOGIN_USER_AGENT,
      });
      if (!res || res.status !== "ok") return; // user closed the window
      await mergePlatformCookies(p.cookieDomain, res.cookies || []);
      // Cookie change → forget the cached session verdict, or the
      // "Session expired" badge outlives the re-login it demanded.
      invalidateInstagramSessionCache();
      if (!connected.includes(p.key)) setConnected([...connected, p.key]);
      await refreshIgSession();
      toast(`${p.label} connected`, "success");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      logError("error", e, `login ${p.key}`);
    } finally {
      busyKey = null;
    }
  }

  async function onLogout(p) {
    if (busyKey) return;
    const ok = await confirmDialog({
      title: `Log out of ${p.label}?`,
      message: "Its saved cookies are removed from this device.",
      confirmLabel: "Log out",
      danger: true,
    });
    if (!ok) return;
    error = "";
    busyKey = p.key;
    try {
      invalidateInstagramSessionCache();
      await removePlatformCookies(p.cookieDomain);
      setConnected(connected.filter((k) => k !== p.key));
      await refreshIgSession();
      toast(`${p.label} disconnected`, "info");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      logError("error", e, `logout ${p.key}`);
    } finally {
      busyKey = null;
    }
  }

  async function onImportCookies() {
    if (importing || !canImport) return;
    error = "";
    importing = true;
    try {
      const picked = await platform.pickFiles({
        multiple: false,
        extensions: ["txt"],
        filterName: "cookies.txt",
      });
      if (!picked || picked.length === 0 || !picked[0].path) return;
      const bytes = await platform.readFileBinary(picked[0].path);
      const text = new TextDecoder().decode(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      );
      await importCookiesText(text);
      // A manual import REPLACES the whole cookies.txt, so any platform we
      // thought was connected via in-app login may no longer be in the
      // file — reset the flags, then re-validate against the fresh file.
      setConnected([]);
      invalidateInstagramSessionCache();
      await revalidate();
      toast("cookies.txt imported", "success");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      logError("error", e, "cookies import");
    } finally {
      importing = false;
    }
  }
</script>

<section class="card">
  <button class="head" on:click={toggleOpen}>
    <div class="head-copy">
      <h2>Platform logins</h2>
      <span class="sub">
        {connected.length > 0
          ? `${connected.length} connected — login stays on this device.`
          : "Sign in to download private, age-restricted or members-only content."}
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
      {#if error}
        <p class="error-line">{error}</p>
      {/if}

      {#each LOGIN_PLATFORMS as p, i (p.key)}
        {@const isConnected = connected.includes(p.key)}
        {@const isBusy = busyKey === p.key}
        {@const sessionDead = p.key === "instagram" && isConnected && igSession === "expired"}
        <div class="row" class:first={i === 0}>
          <div class="icon-box" class:ok={isConnected && !sessionDead} aria-hidden="true">
            {#if isBusy}
              <span class="spinner"></span>
            {:else if isConnected}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            {:else}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <circle cx="8.5" cy="9.5" r="0.5" fill="currentColor" />
                <circle cx="14.5" cy="8.5" r="0.5" fill="currentColor" />
                <circle cx="10" cy="14.5" r="0.5" fill="currentColor" />
                <circle cx="15.5" cy="13.5" r="0.5" fill="currentColor" />
              </svg>
            {/if}
          </div>
          <div class="row-copy">
            <div class="row-title">{p.label}</div>
            <div
              class="row-sub"
              class:ok={isConnected && !sessionDead}
              class:dead={sessionDead}
            >
              {sessionDead
                ? "Session expired — sign in again"
                : isConnected
                  ? "Connected"
                  : p.blurb}
            </div>
            {#if !isConnected && p.note}
              <div class="row-note">{p.note}</div>
            {/if}
          </div>
          {#if isConnected}
            <button class="row-btn" disabled={isBusy} on:click={() => onLogout(p)}>
              Log out
            </button>
          {:else}
            <button class="row-btn primary" disabled={isBusy} on:click={() => onLogin(p)}>
              Log in
            </button>
          {/if}
        </div>
      {/each}

      {#if canImport}
        <button class="import-link" disabled={importing} on:click={onImportCookies}>
          {importing ? "Importing…" : "Import a cookies.txt file for another site →"}
        </button>
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
  }

  .error-line {
    font-size: 0.78rem;
    color: var(--error);
    margin: 0 0 8px 0;
    word-break: break-word;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-top: 1px solid var(--border);
  }

  .row.first { border-top: none; }

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

  .icon-box.ok {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: login-spin 0.8s linear infinite;
  }

  @keyframes login-spin { to { transform: rotate(360deg); } }

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
  }

  .row-sub {
    font-size: 0.78rem;
    color: var(--text-muted);
  }

  .row-sub.ok { color: var(--success); }
  .row-sub.dead { color: var(--error); }

  .row-note {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .row-btn {
    flex-shrink: 0;
    padding: 7px 14px;
    font-size: 0.8rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .row-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  .row-btn:disabled { opacity: 0.6; cursor: default; }

  .row-btn.primary {
    background: var(--accent);
    border-color: transparent;
    color: var(--btn-primary-text);
  }

  .row-btn.primary:hover:not(:disabled) { background: var(--accent-hover); color: var(--btn-primary-text); }

  .import-link {
    align-self: flex-start;
    margin-top: 6px;
    padding: 4px 0;
    font-size: 0.78rem;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--transition-fast);
  }

  .import-link:hover:not(:disabled) { color: var(--accent); }
  .import-link:disabled { cursor: default; }
</style>
