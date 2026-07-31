/**
 * Persistent output history.
 *
 * Conversions / resizes / downloads write a file into exports/ or downloads/,
 * but the only way to reach a result was the in-session OutputPanel — the
 * moment the user tapped "Convert more", every reference was dropped. This
 * keeps a small AsyncStorage-backed index so finished outputs stay reachable
 * (re-share / re-save) until they're purged or deleted.
 *
 * Entries whose underlying file no longer exists (purged by storage.ts after
 * 48h, or deleted by the user) are dropped lazily on read.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

const KEY = '@convertx/history.v1';
const MAX = 60;

export type HistoryOp = 'convert' | 'resize' | 'download';

export type HistoryEntry = {
  id: string;
  /** file:// uri to the output. */
  uri: string;
  name: string;
  bytes: number;
  op: HistoryOp;
  /** Source filename or URL, for context. */
  source?: string;
  /** epoch ms */
  at: number;
};

let cache: HistoryEntry[] | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

async function read(): Promise<HistoryEntry[]> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function write(list: HistoryEntry[]): Promise<void> {
  cache = list;
  emit();
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // non-fatal
  }
}

/** Subscribe to history changes (add/remove/clear). Returns an unsubscribe. */
export function subscribeHistory(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function addHistoryEntry(e: {
  uri: string;
  name: string;
  bytes: number;
  op: HistoryOp;
  source?: string;
}): Promise<void> {
  const list = await read();
  const at = Date.now();
  const entry: HistoryEntry = { ...e, id: `${at}-${e.name}`, at };
  // Newest first; dedupe by uri; cap the list.
  const next = [entry, ...list.filter((x) => x.uri !== e.uri)].slice(0, MAX);
  await write(next);
}

/** Read history, dropping entries whose file has since disappeared. */
export async function getHistory(): Promise<HistoryEntry[]> {
  const list = await read();
  const checked = await Promise.all(
    list.map(async (e) => {
      const info = await FileSystem.getInfoAsync(e.uri).catch(() => null);
      return info && info.exists ? e : null;
    })
  );
  const dead = new Set(
    checked.map((e, i) => (e === null ? list[i].id : null)).filter((id): id is string => id !== null)
  );
  if (dead.size > 0) {
    // Recompute from the LIVE cache, not the snapshot taken before the N
    // async existence checks — an addHistoryEntry that landed mid-check
    // would otherwise be clobbered out of both cache and AsyncStorage.
    const current = cache ?? list;
    const alive = current.filter((e) => !dead.has(e.id));
    await write(alive);
    return alive;
  }
  return list;
}

export async function removeHistoryEntry(id: string): Promise<void> {
  const list = await read();
  await write(list.filter((e) => e.id !== id));
}

export async function clearHistory(): Promise<void> {
  await write([]);
}
