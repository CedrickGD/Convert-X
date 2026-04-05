<script>
  import { theme } from "../stores/themeStore.js";

  let isDark;
  theme.subscribe((v) => (isDark = v === "dark"));
</script>

<button
  class="toggle"
  on:click={() => theme.toggle()}
  aria-label="Toggle theme"
  title={isDark ? "Switch to light mode" : "Switch to dark mode"}
>
  <div class="icon-wrap" class:rotated={!isDark}>
    <!-- Moon (dark mode) -->
    <svg
      class="icon moon"
      class:active={isDark}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>

    <!-- Sun (light mode) -->
    <svg
      class="icon sun"
      class:active={!isDark}
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  </div>
</button>

<style>
  .toggle {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--bg-card);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    overflow: hidden;
  }

  .toggle:hover {
    background: var(--bg-hover);
    border-color: var(--border-hover);
    color: var(--accent);
    transform: scale(1.05);
  }

  .toggle:active {
    transform: scale(0.92);
  }

  .icon-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    width: 16px;
    height: 16px;
    transition: transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .icon-wrap.rotated {
    transform: rotate(180deg);
  }

  .icon {
    position: absolute;
    transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    opacity: 0;
    transform: scale(0.5) rotate(-30deg);
  }

  .icon.active {
    opacity: 1;
    transform: scale(1) rotate(0deg);
  }
</style>
