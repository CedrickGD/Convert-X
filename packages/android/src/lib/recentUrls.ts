/**
 * Recently-probed download URLs — a small persisted MRU list so the most
 * repetitive flow (paste → find → download) can refill the field with one tap.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@convertx/recent-urls.v1';
const MAX = 6;

export async function getRecentUrls(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** Add a URL to the front (deduped, capped). Returns the new list. */
export async function addRecentUrl(url: string): Promise<string[]> {
  const trimmed = url.trim();
  if (!trimmed) return getRecentUrls();
  const list = await getRecentUrls();
  const next = [trimmed, ...list.filter((u) => u !== trimmed)].slice(0, MAX);
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // non-fatal
  }
  return next;
}
