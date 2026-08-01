/**
 * Persistent in-app error log.
 *
 * Release builds have no adb — when a probe or download fails in the
 * field, the only diagnostic trail is what we keep ourselves. A small
 * AsyncStorage-backed ring buffer captures every surfaced failure
 * (explicit logs from catch sites) plus uncaught JS exceptions and
 * unhandled promise rejections, viewable/copyable from Credits.
 *
 * This is deliberately local-only: no network, no external service, no
 * PII beyond what the error strings themselves carry.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@convertx/errorlog.v1';
const MAX = 100;

export type ErrorLogEntry = {
  /** epoch ms */
  at: number;
  /** Where it came from: 'probe', 'download', 'convert', 'crash', 'promise', … */
  scope: string;
  message: string;
  /** Optional context (URL, entry title, …). */
  detail?: string;
};

let cache: ErrorLogEntry[] | null = null;
const listeners = new Set<() => void>();
// Serialize writes — two errors logged in the same tick must both survive.
let op: Promise<void> = Promise.resolve();
// Memoize the cold-start read: two concurrent first reads (a logError and
// the UI mounting) would otherwise each getItem, and the slower one would
// clobber `cache` with pre-write data, silently dropping the fresh entry.
let readInflight: Promise<ErrorLogEntry[]> | null = null;

function emit() {
  listeners.forEach((l) => l());
}

async function read(): Promise<ErrorLogEntry[]> {
  if (cache) return cache;
  if (!readInflight) {
    readInflight = (async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        // A write that raced this read owns the newer truth.
        if (!cache) cache = raw ? (JSON.parse(raw) as ErrorLogEntry[]) : [];
      } catch {
        if (!cache) cache = [];
      } finally {
        readInflight = null;
      }
      return cache as ErrorLogEntry[];
    })();
  }
  return readInflight;
}

export function subscribeErrorLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function logError(scope: string, error: unknown, detail?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  op = op
    .then(async () => {
      const list = await read();
      cache = [{ at: Date.now(), scope, message, detail }, ...list].slice(0, MAX);
      emit();
      await AsyncStorage.setItem(KEY, JSON.stringify(cache)).catch(() => {});
    })
    .catch(() => {});
}

export async function getErrorLog(): Promise<ErrorLogEntry[]> {
  return read();
}

export async function clearErrorLog(): Promise<void> {
  await (op = op.then(async () => {
    cache = [];
    emit();
    await AsyncStorage.removeItem(KEY).catch(() => {});
  }));
}

/**
 * Install the global capture hooks. Idempotent; call once at app start.
 *
 * - ErrorUtils: RN's global JS exception funnel. We log, then delegate to
 *   the previous handler so dev redbox / release crash behavior is
 *   unchanged — this observes crashes, it must never swallow them.
 * - Promise rejection tracking: RN's bundled promise polyfill exposes
 *   enable(); unhandled rejections otherwise vanish silently in release.
 */
let installed = false;
export function installErrorCapture(): void {
  if (installed) return;
  installed = true;

  type ErrorUtilsShape = {
    getGlobalHandler: () => (e: unknown, isFatal?: boolean) => void;
    setGlobalHandler: (h: (e: unknown, isFatal?: boolean) => void) => void;
  };
  const eu = (globalThis as { ErrorUtils?: ErrorUtilsShape }).ErrorUtils;
  if (eu) {
    const prev = eu.getGlobalHandler();
    eu.setGlobalHandler((e, isFatal) => {
      logError(isFatal ? 'crash' : 'error', e);
      prev(e, isFatal);
    });
  }

  const onUnhandled = (_id: number, error: unknown) => {
    logError('promise', error);
  };
  // Hermes keeps its NATIVE Promise — the npm `promise` polyfill's
  // rejection tracking instruments a class nothing uses there, so hook
  // Hermes' own tracker first and use the polyfill only as the fallback
  // for non-Hermes engines.
  const hermes = (globalThis as {
    HermesInternal?: {
      enablePromiseRejectionTracker?: (opts: {
        allRejections: boolean;
        onUnhandled: (id: number, error: unknown) => void;
        onHandled?: (id: number) => void;
      }) => void;
    };
  }).HermesInternal;
  if (hermes?.enablePromiseRejectionTracker) {
    try {
      hermes.enablePromiseRejectionTracker({ allRejections: true, onUnhandled });
      return;
    } catch {
      // Fall through to the polyfill attempt.
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tracking = require('promise/setimmediate/rejection-tracking') as {
      enable: (opts: {
        allRejections: boolean;
        onUnhandled: (id: number, error: unknown) => void;
      }) => void;
    };
    tracking.enable({ allRejections: true, onUnhandled });
  } catch {
    // Polyfill layout changed — explicit logs still work.
  }
}
