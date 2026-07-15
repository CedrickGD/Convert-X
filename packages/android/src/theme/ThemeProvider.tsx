import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';

import { ColorScheme, resolveTheme, Theme } from './palettes';

const STORAGE_KEY = '@convertx/settings.v1';

/** How many recently-picked custom accents to remember. */
const RECENT_MAX = 8;
/** Cap on the editable quick-picks row. */
export const QUICK_PICKS_MAX = 12;

/** Seed swatches for a fresh install (matches the Credits preset names). */
export const DEFAULT_QUICK_PICKS = [
  '#10b981', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899',
  '#f43f5e', '#f97316', '#f59e0b', '#06b6d4', '#84cc16',
];

type PersistedSettings = {
  colorScheme: ColorScheme;
  /** User-chosen accent hex ("#7c3aed"). null = stock emerald. */
  accentColor: string | null;
  /** Recently committed custom accents, newest first (deduped, capped).
   *  Retained for migration; the UI now uses quickPicks. */
  recentAccents: string[];
  /** The editable quick-picks swatch row (newest first when auto is on). */
  quickPicks: string[];
  /** When true, committing an accent prepends it to quickPicks. */
  quickPicksAuto: boolean;
};

const DEFAULT_SETTINGS: PersistedSettings = {
  colorScheme: 'dark',
  accentColor: null,
  recentAccents: [],
  quickPicks: DEFAULT_QUICK_PICKS,
  quickPicksAuto: true,
};

const dedupeCap = (list: string[], max: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of list) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
};

type ThemeContextValue = {
  theme: Theme;
  settings: PersistedSettings;
  setColorScheme: (scheme: ColorScheme) => void;
  /** Override the accent color; pass null to reset to the default emerald. */
  setAccentColor: (hex: string | null) => void;
  /**
   * Re-theme live WITHOUT persisting — for the color picker while dragging.
   * Commit the final value with setAccentColor on release.
   */
  previewAccentColor: (hex: string | null) => void;
  /** Replace the editable quick-picks row (remove / add / reorder). */
  setQuickPicks: (next: string[]) => void;
  /** Toggle auto-adding the last-used color to quick picks. */
  setQuickPicksAuto: (on: boolean) => void;
  hydrated: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

async function loadSettings(): Promise<PersistedSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // Migrate pre-quickPicks installs: seed the row from any remembered
    // recents (newest first) followed by the default swatches.
    if (!Array.isArray(parsed.quickPicks)) {
      merged.quickPicks = dedupeCap(
        [...(parsed.recentAccents ?? []), ...DEFAULT_QUICK_PICKS],
        QUICK_PICKS_MAX
      );
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

async function saveSettings(settings: PersistedSettings): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // persist failure is non-fatal
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [settings, setSettings] = useState<PersistedSettings>(DEFAULT_SETTINGS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    loadSettings().then((loaded) => {
      setSettings(loaded);
      setHydrated(true);
    });
  }, []);

  const update = useCallback(
    (
      patch:
        | Partial<PersistedSettings>
        | ((prev: PersistedSettings) => Partial<PersistedSettings>)
    ) => {
      setSettings((prev) => {
        const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
        saveSettings(next);
        return next;
      });
    },
    []
  );

  // Live preview: update in-memory only (no AsyncStorage write). Dedupe so an
  // unchanged hex during a drag doesn't trigger a full-app re-theme.
  const previewAccentColor = useCallback((hex: string | null) => {
    setSettings((prev) => (prev.accentColor === hex ? prev : { ...prev, accentColor: hex }));
  }, []);

  const isDark =
    settings.colorScheme === 'system' ? systemScheme !== 'light' : settings.colorScheme === 'dark';

  const theme = useMemo(() => resolveTheme(isDark, settings.accentColor), [isDark, settings.accentColor]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      settings,
      hydrated,
      setColorScheme: (scheme) => update({ colorScheme: scheme }),
      setAccentColor: (hex) =>
        update((prev) => {
          if (!hex) return { accentColor: null };
          const patch: Partial<PersistedSettings> = {
            accentColor: hex,
            recentAccents: dedupeCap([hex, ...prev.recentAccents], RECENT_MAX),
          };
          // Last-used lands at the front of the quick-picks row when auto is on.
          if (prev.quickPicksAuto) {
            patch.quickPicks = dedupeCap([hex, ...prev.quickPicks], QUICK_PICKS_MAX);
          }
          return patch;
        }),
      previewAccentColor,
      setQuickPicks: (next) => update({ quickPicks: dedupeCap(next, QUICK_PICKS_MAX) }),
      setQuickPicksAuto: (on) => update({ quickPicksAuto: on }),
    }),
    [theme, settings, hydrated, update, previewAccentColor]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
