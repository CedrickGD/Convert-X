<script>
  import ColorPicker from "./ColorPicker.svelte";
  import { accent, theme, stockAccent, DEFAULT_QUICK_PICKS } from "../stores/themeStore.js";
  import { normalizeHex, readableOn } from "../lib/color.js";

  /**
   * Accent-colour card — port of the Android AccentColorCard
   * (packages/android/src/screens/CreditsScreen.tsx:249-474). Collapsed by
   * default; expanding reveals the picker, an editable quick-picks row and a
   * hex field. Pure CSS custom properties + localStorage, so it ships on web
   * and desktop alike.
   */

  let open = false;
  let editing = false;

  // No override → the stylesheet's per-scheme emerald is what's on screen,
  // so that (not a fixed hex) is the colour the card must reflect.
  $: stock = stockAccent($theme);
  $: current = $accent.color ?? stock;
  $: isDefault = !$accent.color;
  $: summary = isDefault ? "Default emerald" : `Custom · ${$accent.color}`;

  // The hex field doubles as a live readout: it mirrors the current colour
  // (updating as the picker is dragged) unless the user is editing it.
  let hexInput = "";
  let hexFocused = false;
  let hexError = false;
  $: if (!hexFocused) {
    hexInput = current;
    hexError = false;
  }
  $: livePreview = normalizeHex(hexInput);

  $: quickPicks = $accent.quickPicks;
  $: currentInPicks = quickPicks.some((c) => c.toLowerCase() === current.toLowerCase());

  /** Picking the scheme's stock colour means "no override", not a custom one. */
  function selectColor(hex) {
    accent.setColor(hex.toLowerCase() === stock.toLowerCase() ? null : hex);
  }

  function onSwatch(hex) {
    if (editing) accent.setQuickPicks(quickPicks.filter((c) => c.toLowerCase() !== hex.toLowerCase()));
    else selectColor(hex);
  }

  function applyHex() {
    const norm = normalizeHex(hexInput);
    if (!norm) {
      hexError = true;
      return;
    }
    hexError = false;
    hexFocused = false;
    selectColor(norm);
  }
</script>

<section class="card">
  <button class="head" on:click={() => (open = !open)}>
    <div class="head-copy">
      <h2>Accent color</h2>
      <span class="sub">{summary}</span>
    </div>
    <div class="head-right">
      <span class="dot" style={`background: ${current}`}></span>
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
    </div>
  </button>

  {#if open}
    <div class="body">
      <ColorPicker
        value={current}
        onPreview={(hex) => accent.preview(hex)}
        onCommit={(hex) => selectColor(hex)}
      />

      <div class="row-head">
        <h3>Quick picks</h3>
        <div class="row-links">
          {#if editing}
            <button class="link" on:click={() => accent.setQuickPicks(DEFAULT_QUICK_PICKS)}>
              Restore defaults
            </button>
          {/if}
          <button class="link" on:click={() => (editing = !editing)}>
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      <div class="swatches">
        {#each quickPicks as hex (hex)}
          <button
            class="swatch"
            class:selected={!editing && current.toLowerCase() === hex.toLowerCase()}
            style={`background: ${hex}`}
            title={editing ? `Remove ${hex}` : hex}
            aria-label={editing ? `Remove ${hex} from quick picks` : `Use accent ${hex}`}
            on:click={() => onSwatch(hex)}
          >
            {#if editing}
              <span class="badge">×</span>
            {:else if current.toLowerCase() === hex.toLowerCase()}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={readableOn(hex)}
                stroke-width="3.5"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              ><polyline points="20 6 9 17 4 12" /></svg>
            {/if}
          </button>
        {/each}

        {#if editing && !currentInPicks}
          <button
            class="swatch add"
            aria-label="Add the current color to quick picks"
            title="Add the current color"
            on:click={() => accent.setQuickPicks([current, ...quickPicks])}
          >+</button>
        {/if}
      </div>

      <label class="auto-row">
        <span>Auto-add last used color</span>
        <input
          type="checkbox"
          checked={$accent.quickPicksAuto}
          on:change={(e) => accent.setQuickPicksAuto(e.currentTarget.checked)}
        />
        <span class="track" aria-hidden="true"><span class="knob"></span></span>
      </label>

      <div class="hex-row" class:invalid={hexError}>
        <span class="dot small" style={`background: ${livePreview ?? current}`}></span>
        <input
          type="text"
          class="hex-input"
          bind:value={hexInput}
          placeholder="#7c3aed"
          spellcheck="false"
          autocomplete="off"
          aria-label="Accent hex value"
          on:focus={() => (hexFocused = true)}
          on:blur={() => (hexFocused = false)}
          on:input={() => (hexError = false)}
          on:keydown={(e) => e.key === "Enter" && applyHex()}
        />
        <!-- preventDefault keeps focus on the field: a blur would re-sync
             hexInput to the live colour before the click landed. -->
        <button class="link" on:mousedown|preventDefault on:click={applyHex}>Apply</button>
      </div>

      {#if hexError}
        <p class="err">Enter a valid hex, e.g. #7c3aed.</p>
      {/if}

      {#if !isDefault}
        <button class="link reset" on:click={() => accent.setColor(null)}>Reset to default</button>
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

  .head-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  h2 {
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    margin: 0;
  }

  h3 {
    font-size: 0.72rem;
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

  .dot {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid var(--border);
    flex-shrink: 0;
  }

  .dot.small { width: 16px; height: 16px; }

  .chev {
    flex-shrink: 0;
    color: var(--text-muted);
    transition: transform var(--transition-fast);
  }

  .chev.open { transform: rotate(90deg); }

  .body {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .row-links {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .link {
    background: transparent;
    padding: 0;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--accent);
    cursor: pointer;
  }

  .link:hover { color: var(--accent-hover); }

  .reset { align-self: flex-start; }

  .swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .swatch {
    position: relative;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 2px solid transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform var(--transition-fast), border-color var(--transition-fast);
  }

  .swatch:hover { transform: scale(1.08); }
  .swatch.selected { border-color: var(--text-primary); }

  .swatch .badge {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
    font-size: 0.9rem;
    line-height: 26px;
    font-weight: 700;
  }

  .swatch.add {
    background: transparent;
    border: 1px dashed var(--border-hover);
    color: var(--text-secondary);
    font-size: 1rem;
    line-height: 1;
  }

  .auto-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 0.82rem;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .auto-row input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }

  .track {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 999px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    flex-shrink: 0;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }

  .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-secondary);
    transition: transform var(--transition-fast), background var(--transition-fast);
  }

  .auto-row input:checked ~ .track {
    background: var(--accent);
    border-color: var(--accent);
  }

  .auto-row input:checked ~ .track .knob {
    transform: translateX(16px);
    background: var(--btn-primary-text);
  }

  .auto-row input:focus-visible ~ .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .hex-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  .hex-row.invalid { border-color: var(--error); }

  .hex-input {
    flex: 1;
    min-width: 0;
    font-size: 0.85rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .err {
    font-size: 0.78rem;
    color: var(--error);
    margin: 0;
  }
</style>
