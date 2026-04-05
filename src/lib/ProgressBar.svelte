<script>
  export let progress = 0;
  export let elapsed = "00:00";
  export let label = "Converting...";

  $: pct = Math.min(100, Math.max(0, Math.round(progress)));
</script>

<div class="progress">
  <div class="head">
    <span class="label">
      {#if pct < 100}
        {label}
      {:else}
        Finishing up...
      {/if}
    </span>
    <span class="pct">{pct}<span class="pct-sign">%</span></span>
  </div>

  <div class="track">
    <div class="fill" style="width: {pct}%">
      {#if pct < 100 && pct > 3}
        <div class="glow"></div>
      {/if}
    </div>
  </div>

  <div class="foot">
    <span>{elapsed}</span>
  </div>
</div>

<style>
  .progress {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 20px;
    animation: fadeUp 0.3s ease-out;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 14px;
  }

  .label {
    font-weight: 500;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }

  .pct {
    color: var(--accent);
    font-weight: 700;
    font-size: 1.4rem;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }

  .pct-sign {
    font-size: 0.8rem;
    opacity: 0.6;
  }

  .track {
    width: 100%;
    height: 6px;
    background: var(--border);
    border-radius: 3px;
    overflow: hidden;
  }

  .fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
  }

  .glow {
    position: absolute;
    right: 0;
    top: -2px;
    bottom: -2px;
    width: 40px;
    background: linear-gradient(90deg, transparent, var(--accent-hover));
    border-radius: 3px;
    animation: shimmer 1.5s ease-in-out infinite;
    opacity: 0.6;
  }

  @keyframes shimmer {
    0%, 100% { opacity: 0.3; }
    50% { opacity: 0.8; }
  }

  .foot {
    margin-top: 8px;
    font-size: 0.72rem;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
