<script>
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
  </button>
  <button
    class="tab"
    class:active={activeMode === "resize"}
    on:click={() => onModeChange("resize")}
  >
    Resize
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

</style>
