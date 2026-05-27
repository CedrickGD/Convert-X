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

type PersistedSettings = {
  colorScheme: ColorScheme;
  /** User-chosen accent hex ("#7c3aed"). null = stock emerald. */
  accentColor: string | null;
};

const DEFAULT_SETTINGS: PersistedSettings = {
  colorScheme: 'dark',
  accentColor: null,
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
  hydrated: boolean;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

async function loadSettings(): Promise<PersistedSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
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

  const update = useCallback((patch: Partial<PersistedSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

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
      setAccentColor: (hex) => update({ accentColor: hex }),
      previewAccentColor,
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
