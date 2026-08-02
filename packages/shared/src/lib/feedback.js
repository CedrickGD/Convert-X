/**
 * App-styled feedback primitives: a single-slot auto-dismiss toast and a
 * promise-based themed confirm dialog.
 *
 * The stores here drive the shared <Toast/> and <ConfirmDialog/> host
 * components (mounted once in App.svelte). Call toast(...) /
 * confirmDialog(...) from anywhere — platform-free and web-safe.
 */
import { writable } from "svelte/store";

const TOAST_MS = 2800;

/** { message, variant: 'success'|'error'|'info' } | null */
export const toastStore = writable(null);

let toastTimer = null;

/** Show a transient toast. Single slot — a new toast replaces the current
 *  one and restarts the auto-dismiss timer (2800ms). */
export function toast(message, variant = "info") {
  if (toastTimer) clearTimeout(toastTimer);
  toastStore.set({ message, variant });
  toastTimer = setTimeout(() => {
    toastTimer = null;
    toastStore.set(null);
  }, TOAST_MS);
}

/** Dismiss the current toast immediately (tap-to-dismiss). */
export function dismissToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastStore.set(null);
}

/** { title, message, confirmLabel, cancelLabel, danger, resolve } | null */
export const confirmStore = writable(null);

/**
 * Show a themed confirm dialog. Resolves true on confirm, false on
 * cancel / scrim click / Escape. A second dialog opened while one is
 * showing settles the first as cancelled.
 */
export function confirmDialog({
  title,
  message = "",
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
}) {
  return new Promise((resolve) => {
    confirmStore.update((prev) => {
      // Never leave an earlier caller hanging on an orphaned promise.
      if (prev && typeof prev.resolve === "function") prev.resolve(false);
      return { title, message, confirmLabel, cancelLabel, danger, resolve };
    });
  });
}

/** Settle and close the open confirm dialog. Used by the host component. */
export function closeConfirm(result) {
  confirmStore.update((state) => {
    if (state && typeof state.resolve === "function") state.resolve(!!result);
    return null;
  });
}
