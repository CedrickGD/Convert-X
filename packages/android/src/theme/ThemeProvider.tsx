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

import {
  AccentKey,
  ColorScheme,
  Palette,
  PRESET_PALETTES,
  resolveTheme,
  Theme,
} from './palettes';

const STORAGE_KEY = '@convertx/settings.v1';

type PersistedSettings = {
  /** Pre-redesign multi-accent picker; kept for storage compat, ignored. */
  accent: AccentKey;
  customHue: number;
  customSaturation: number;
  colorScheme: ColorScheme;
};

const DEFAULT_SETTINGS: PersistedSettings = {
  accent: 'emerald',
  customHue: 160,
  customSaturation: 82,
  colorScheme: 'dark',
};

type ThemeContextValue = {
  theme: Theme;
  palette: Palette;
  settings: PersistedSettings;
  /** No-op — desktop has a single accent. Kept for source-compat. */
  setAccent: (key: AccentKey) => void;
  /** No-op — kept for source-compat. */
  setCustomHue: (hue: number) => void;
  /** No-op — kept for source-compat. */
  setCustomSaturation: (saturation: number) => void;
  setColorScheme: (scheme: ColorScheme) => void;
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

  const isDark =
    settings.colorScheme === 'system' ? systemScheme !== 'light' : settings.colorScheme === 'dark';

  const theme = useMemo(() => resolveTheme(isDark), [isDark]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      palette: PRESET_PALETTES[0],
      settings,
      hydrated,
      setAccent: () => {
        // intentional no-op — only one accent on desktop
      },
      setCustomHue: () => {},
      setCustomSaturation: () => {},
      setColorScheme: (scheme) => update({ colorScheme: scheme }),
    }),
    [theme, settings, hydrated, update]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
