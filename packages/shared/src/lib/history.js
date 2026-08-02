/**
 * Persistent download history.
 *
 * Finished downloads used to live only in the in-session done view — the
 * moment the user reset, every reference was dropped. This keeps a small
 * localStorage-backed index so finished outputs stay reachable (open file
 * / open folder) until they're deleted or pruned.
 *
 * Entries whose underlying file no longer exists (deleted by the user)
 * are dropped lazily on read via the platform adapter's optional
 * fileExists — when the method is absent (web), pruning is skipped and
 * the list is returned as-is.
 *
 * Entry shape:
 *   { id, title, outputPath, sourceUrl, mediaType, at }
 */
import { getPlatform } from "../platform.js";
import { loadJson, saveJson, removeKey } from "./storage.js";

const KEY = "convertx.history.v1";
const MAX = 60;

let cache = null;
const listeners = new Set();

function emit() {
  listeners.forEach((l) => {
    try {
      l();
    } catch {
      // ignore broken subscribers
    }
  });
}

/**
 * Row key. outputPath is the uniqueness key enforced by the dedupe in
 * addHistoryEntry, so folding it in keeps ids unique — the caller-supplied
 * media id is stable across re-downloads (same IG pk / Twitter status) and
 * would collide as soon as one media lands at two paths, which breaks the
 * keyed {#each} in HistoryView and makes pruning/removal hit siblings.
 */
function rowId(at, outputPath) {
  return `${at}-${outputPath}`;
}

function read() {
  if (!cache) {
    const raw = loadJson(KEY, []);
    const list = Array.isArray(raw) ? raw : [];
    // Rows persisted before ids were derived can carry a colliding media id.
    cache = list.map((e) =>
      e && typeof e.outputPath === "string" && e.outputPath.length > 0
        ? { ...e, id: rowId(e.at, e.outputPath) }
        : e
    );
  }
  return cache;
}

function write(list) {
  cache = list;
  saveJson(KEY, list);
  emit();
}

/** Subscribe to history changes (add/remove/clear). Returns an unsubscribe. */
export function subscribeHistory(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Add a finished download. Newest first, deduped by outputPath, capped.
 * `at` is filled in when omitted; the row id is always derived (see rowId) —
 * a caller-supplied media id is NOT unique per row.
 */
export function addHistoryEntry(e) {
  if (!e || typeof e.outputPath !== "string" || e.outputPath.length === 0) return;
  const at = typeof e.at === "number" ? e.at : Date.now();
  const entry = {
    id: rowId(at, e.outputPath),
    title: typeof e.title === "string" ? e.title : "Untitled",
    outputPath: e.outputPath,
    sourceUrl: typeof e.sourceUrl === "string" ? e.sourceUrl : null,
    mediaType: typeof e.mediaType === "string" ? e.mediaType : null,
    at,
  };
  const list = read();
  const next = [entry, ...list.filter((x) => x.outputPath !== entry.outputPath)].slice(0, MAX);
  write(next);
}

/**
 * Read history, lazily dropping entries whose file has since disappeared.
 * Pruning requires the platform adapter's fileExists — skipped when the
 * method is absent (web) or the adapter isn't initialized.
 */
export async function getHistory() {
  const list = read();
  let platform = null;
  try {
    platform = getPlatform();
  } catch {
    platform = null;
  }
  if (!platform || typeof platform.fileExists !== "function") return list;

  const checked = await Promise.all(
    list.map(async (e) => {
      try {
        const exists = await platform.fileExists(e.outputPath);
        return exists ? e : null;
      } catch {
        // An unanswerable check must not delete history.
        return e;
      }
    })
  );
  const dead = new Set(
    checked.map((e, i) => (e === null ? list[i].id : null)).filter((id) => id !== null)
  );
  if (dead.size > 0) {
    // Recompute from the LIVE cache, not the snapshot taken before the N
    // async existence checks — an addHistoryEntry that landed mid-check
    // would otherwise be clobbered.
    const current = cache ?? list;
    const alive = current.filter((e) => !dead.has(e.id));
    write(alive);
    return alive;
  }
  return list;
}

export function removeHistoryEntry(id) {
  write(read().filter((e) => e.id !== id));
}

export function clearHistory() {
  cache = [];
  removeKey(KEY);
  emit();
}
