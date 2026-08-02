<script>
  import { toastStore, dismissToast } from "../lib/feedback.js";

  // Single-slot toast host — mount once in App.svelte. Driven entirely by
  // the feedback store: call toast(message, variant) from anywhere.
</script>

{#if $toastStore}
  <div class="toast-wrap" role="status" aria-live="polite">
    <button
      class="toast"
      class:success={$toastStore.variant === "success"}
      class:error={$toastStore.variant === "error"}
      on:click={dismissToast}
    >
      <span class="icon" aria-hidden="true">
        {#if $toastStore.variant === "success"}
          ✓
        {:else if $toastStore.variant === "error"}
          !
        {:else}
          i
        {/if}
      </span>
      <span class="msg">{$toastStore.message}</span>
    </button>
  </div>
{/if}

<style>
  .toast-wrap {
    position: fixed;
    left: 24px;
    right: 24px;
    bottom: 28px;
    display: flex;
    justify-content: center;
    pointer-events: none;
    z-index: 1000;
  }

  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 460px;
    padding: 10px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    animation: toast-in 0.26s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 700;
    background: var(--accent-glow);
    color: var(--accent);
  }

  .toast.success .icon {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
  }

  .toast.error .icon {
    background: var(--error-dim);
    color: var(--error);
  }

  .msg {
    flex-shrink: 1;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
