/**
 * Persistent in-app error log.
 *
 * When a probe or download fails in the field, the only diagnostic trail
 * is what we keep ourselves. A small localStorage-backed ring buffer
 * captures every surfaced failure (explicit logs from catch sites) plus
 * uncaught JS exceptions and unhandled promise rejections, viewable and
 * copyable from Credits.
 *
 * This is deliberately local-only: no network, no external service, no
 * PII beyond what the error strings themselves carry. Web-safe and
 * un-gated — it touches no platform adapter methods.
 *
 * Entry shape: { at: epoch ms, scope: 'probe'|'download'|'convert'|
 * 'crash'|'error'|'promise'|…, message, detail? }.
 */

import { loadJson, saveJson, removeKey } from "./storage.js";

const KEY = "convertx.errorLog.v1";
const MAX = 100;

let cache = null;
const listeners = new Set();

function emit() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      // A broken subscriber must not break logging.
    }
  });
}

function read() {
  if (!cache) {
    const raw = loadJson(KEY, []);
    cache = Array.isArray(raw) ? raw : [];
  }
  return cache;
}

/** Subscribe to log changes (add/clear). Returns an unsubscribe. */
export function subscribeErrorLog(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Append an entry (newest first, capped at 100). `error` may be an Error,
 * a string, or anything stringifiable. `detail` is optional context
 * (URL, entry title, …).
 */
export function logError(scope, error, detail) {
  const message = error instanceof Error ? error.message : String(error);
  const entry = { at: Date.now(), scope, message };
  if (detail !== undefined && detail !== null) entry.detail = String(detail);
  cache = [entry, ...read()].slice(0, MAX);
  saveJson(KEY, cache);
  emit();
}

/** Newest-first list of logged errors. */
export function getErrorLog() {
  return read();
}

export function clearErrorLog() {
  cache = [];
  removeKey(KEY);
  emit();
}

/**
 * Install the global capture hooks. Idempotent; call once at app start.
 *
 * Uses addEventListener so existing handlers (dev overlays, the
 * browser's own console reporting) are untouched — this observes
 * failures, it must never swallow them.
 */
let installed = false;
export function installGlobalErrorCapture() {
  if (installed) return;
  installed = true;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;

  window.addEventListener("error", (event) => {
    // Resource-load errors (img/script) have no message — skip the noise.
    const err = event?.error ?? event?.message;
    if (!err) return;
    logError("crash", err, typeof event.filename === "string" && event.filename ? `${event.filename}:${event.lineno ?? 0}` : undefined);
  });

  window.addEventListener("unhandledrejection", (event) => {
    logError("promise", event?.reason ?? "Unhandled promise rejection");
  });
}
