import AsyncStorage from '@react-native-async-storage/async-storage';

export type HistoryItem = {
  id: string;
  timestamp: number;
  sourceName: string;
  outputName: string;
  outputUri: string;
  bytes: number;
  formatKey: string;
};

const KEY = '@convertx/history.v1';
const MAX_ITEMS = 50;

export async function loadHistory(): Promise<HistoryItem[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    return JSON.parse(raw) as HistoryItem[];
  } catch {
    return [];
  }
}

export async function addHistory(item: HistoryItem): Promise<void> {
  const current = await loadHistory();
  const next = [item, ...current].slice(0, MAX_ITEMS);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

export async function removeHistory(id: string): Promise<void> {
  const current = await loadHistory();
  const next = current.filter((x) => x.id !== id);
  await AsyncStorage.setItem(KEY, JSON.stringify(next));
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
