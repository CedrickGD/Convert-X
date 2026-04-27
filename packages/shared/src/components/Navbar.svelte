<script>
  import { convertBusy, resizeBusy, downloadBusy } from "../stores/fileStore.js";
  export let activeMode;
  export let onModeChange;
</script>

<nav class="navbar">
  <button
    class="tab"
    class:active={activeMode === "convert"}
    on:click={() => onModeChange("convert")}
  >
    Convert
    {#if $convertBusy}<span class="busy-dot" aria-label="conversion in progress"></span>{/if}
  </button>
  <button
    class="tab"
    class:active={activeMode === "resize"}
    on:click={() => onModeChange("resize")}
  >
    Resize
    {#if $resizeBusy}<span class="busy-dot" aria-label="resize in progress"></span>{/if}
  </button>
  <button
    class="tab"
    class:active={activeMode === "download"}
    on:click={() => onModeChange("download")}
  >
    Download
    {#if $downloadBusy}<span class="busy-dot" aria-label="download in progress"></span>{/if}
  </button>
  <button
    class="tab"
    class:active={activeMode === "credits"}
    on:click={() => onModeChange("credits")}
  >
    Credits &amp; App
  </button>
</nav>

<style>
  .navbar {
    display: flex;
    gap: 4px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px;
    margin-top: 8px;
  }

  .tab {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: calc(var(--radius-sm) - 3px);
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-muted);
    background: transparent;
    transition: all var(--transition-fast);
  }

  .tab:hover:not(.active) {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  .tab.active {
    background: var(--bg-card);
    color: var(--text-primary);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  }

  .busy-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow, var(--accent));
    animation: busyPulse 1.4s ease-in-out infinite;
  }

  @keyframes busyPulse {
    0%, 100% { opacity: 0.6; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.1); }
  }
</style>
