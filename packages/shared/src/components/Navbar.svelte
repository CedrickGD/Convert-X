<script>
  import { convertBusy, resizeBusy, downloadBusy } from "../stores/fileStore.js";
  import { getPlatform } from "../platform.js";
  import { onMount, tick } from "svelte";
  export let activeMode;
  export let onModeChange;

  // History only exists where downloads produce on-disk files the app can
  // reopen — desktop. Gating here keeps the web tab set unchanged.
  const isDesktop = getPlatform().platformType === "desktop";

  // Data-driven so the sliding indicator measures whatever buttons actually
  // exist: the tab set differs between desktop (5) and web (4).
  $: tabs = [
    { key: "convert", label: "Convert", busy: $convertBusy },
    { key: "resize", label: "Resize", busy: $resizeBusy },
    { key: "download", label: "Download", busy: $downloadBusy },
    ...(isDesktop ? [{ key: "history", label: "History", busy: false }] : []),
    { key: "credits", label: "Credits", busy: false },
  ];

  $: activeIndex = tabs.findIndex((t) => t.key === activeMode);

  let navEl;
  let tabEls = [];
  let indicatorX = 0;
  let indicatorW = 0;
  // The first placement snaps, every later move eases — otherwise the pill
  // would slide in from the left edge on the very first paint.
  let placed = false;

  function measure() {
    const el = tabEls[activeIndex];
    if (!navEl || !el) {
      indicatorW = 0;
      return;
    }
    // offsetLeft/offsetWidth are relative to .navbar (position: relative),
    // so the indicator tracks flex sizing instead of hardcoded tab widths.
    indicatorX = el.offsetLeft;
    indicatorW = el.offsetWidth;
    if (!placed && indicatorW > 0) {
      // Let the snapped position paint before transitions are switched on.
      requestAnimationFrame(() => requestAnimationFrame(() => (placed = true)));
    }
  }

  // Re-measure after the DOM settles whenever the active tab or the tab set
  // changes (busy dots included — they re-render the buttons).
  function scheduleMeasure(..._deps) {
    if (navEl) tick().then(measure);
  }
  $: scheduleMeasure(tabs, activeIndex, navEl);

  onMount(() => {
    // Tabs are flex-sized, so every window resize moves the target.
    const ro = new ResizeObserver(() => measure());
    ro.observe(navEl);
    return () => ro.disconnect();
  });
</script>

<nav class="navbar" bind:this={navEl}>
  <!-- Sliding active-tab indicator — sits under the labels and eases between
       tabs instead of the active background hard-cutting across. Mirrors
       packages/android/src/components/Navbar.tsx. -->
  <span
    class="indicator"
    class:placed
    aria-hidden="true"
    style="transform: translateX({indicatorX}px); width: {indicatorW}px;"
  ></span>

  {#each tabs as tab, i (tab.key)}
    <button
      bind:this={tabEls[i]}
      class="tab"
      class:active={activeMode === tab.key}
      aria-current={activeMode === tab.key ? "page" : undefined}
      on:click={() => onModeChange(tab.key)}
    >
      {tab.label}
      {#if tab.busy}
        <span class="busy-dot" aria-label="{tab.label} in progress"></span>
      {/if}
    </button>
  {/each}
</nav>

<style>
  .navbar {
    position: relative;
    display: flex;
    gap: 4px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 3px;
    margin-top: 8px;
  }

  .indicator {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 0;
    width: 0;
    border-radius: calc(var(--radius-sm) - 3px);
    background: var(--bg-card);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
    pointer-events: none;
  }

  .indicator.placed {
    transition: transform var(--transition), width var(--transition);
  }

  .tab {
    position: relative;
    /* Above the indicator, which is painted first as a sibling. */
    z-index: 1;
    flex: 1;
    /* Required with nowrap: min-width:auto would refuse to shrink a tab
       below its label and push the whole bar wider than the window. */
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Horizontal padding is deliberately small: at the desktop window's
       500-600px width five tabs share ~90-110px each, and 16px side padding
       made the longest label wrap to a second line — which made the whole
       bar 54px tall instead of 39px. nowrap makes that unrepresentable. */
    padding: 8px;
    border-radius: calc(var(--radius-sm) - 3px);
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
    color: var(--text-muted);
    background: transparent;
    transition: color var(--transition-fast), background-color var(--transition-fast),
      transform var(--transition-fast);
  }

  .tab:hover:not(.active) {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  /* The active pill is the sliding indicator — the tab only shifts its ink. */
  .tab.active {
    color: var(--text-primary);
  }

  .busy-dot {
    /* Absolute (as on Android) so starting a batch doesn't shove the label
       sideways, and so the dot can't widen a tab past its share of the bar. */
    position: absolute;
    top: 5px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent-glow, var(--accent));
    /* Pop in once, then idle-pulse. The pulse is delayed by the pop's
       duration so it doesn't overwrite the pop's transform/opacity. */
    animation: busyPop 0.22s cubic-bezier(0.34, 1.56, 0.64, 1),
      busyPulse 1.4s ease-in-out 0.22s infinite;
  }

  @keyframes busyPop {
    from { opacity: 0; transform: scale(0.2); }
    to { opacity: 0.6; transform: scale(0.9); }
  }

  @keyframes busyPulse {
    0%, 100% { opacity: 0.6; transform: scale(0.9); }
    50% { opacity: 1; transform: scale(1.1); }
  }
</style>
