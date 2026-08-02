<script>
  import { confirmStore, closeConfirm } from "../lib/feedback.js";

  // Promise-based themed confirm host — mount once in App.svelte. Driven
  // by the feedback store: await confirmDialog({ title, message,
  // confirmLabel, danger }) from anywhere; resolves true/false.

  function onKeydown(e) {
    if (!$confirmStore) return;
    if (e.key === "Escape") closeConfirm(false);
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if $confirmStore}
  <div class="scrim" on:click={() => closeConfirm(false)} role="presentation">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={$confirmStore.title}
      tabindex="-1"
      on:click|stopPropagation
      on:keydown|stopPropagation={(e) => {
        if (e.key === "Escape") closeConfirm(false);
      }}
    >
      <div class="title">{$confirmStore.title}</div>
      {#if $confirmStore.message}
        <div class="message">{$confirmStore.message}</div>
      {/if}
      <div class="actions">
        <button class="btn cancel" on:click={() => closeConfirm(false)}>
          {$confirmStore.cancelLabel || "Cancel"}
        </button>
        <button
          class="btn confirm"
          class:danger={$confirmStore.danger}
          on:click={() => closeConfirm(true)}
        >
          {$confirmStore.confirmLabel || "OK"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    background: rgba(0, 0, 0, 0.55);
    z-index: 1100;
    animation: scrim-in 0.2s ease-out;
  }

  .dialog {
    width: 100%;
    max-width: 400px;
    padding: 22px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    animation: dialog-in 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .title {
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .message {
    margin-top: 8px;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-line;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 20px;
  }

  .btn {
    min-width: 96px;
    padding: 9px 18px;
    border-radius: var(--radius-xs);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--transition-fast), background var(--transition-fast);
  }

  .btn.cancel {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-secondary);
  }

  .btn.cancel:hover {
    background: var(--bg-hover);
  }

  .btn.confirm {
    background: var(--accent);
    border: 1px solid transparent;
    color: var(--btn-primary-text);
  }

  .btn.confirm:hover {
    opacity: 0.85;
  }

  .btn.confirm.danger {
    background: var(--error);
    color: #fff;
  }

  @keyframes scrim-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes dialog-in {
    from {
      opacity: 0;
      transform: scale(0.94);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
