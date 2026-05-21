/**
 * Convert-X Android color tokens.
 *
 * 1:1 mirror of the desktop Convert-X palette
 * (Convert-X/packages/shared/src/assets/styles.css). Dark = near-black bg with
 * an emerald accent. Light = bone-white with deep emerald. When changing here,
 * change the desktop CSS in lockstep.
 *
 * The desktop app has a single accent; the multi-palette / custom-hue UI in
 * the pre-redesign Android scaffold is on its way out (Phase 3). The legacy
 * `Palette`, `PRESET_PALETTES`, `paletteFromKey`, `buildTheme` exports at the
 * bottom of this file are shims so the pre-redesign screens compile until
 * they are replaced.
 */

export type ColorScheme = 'light' | 'dark' | 'system';

/**
 * Kept as a wider union for source-compat with the pre-redesign UI
 * (multi-accent picker). Desktop has a single emerald accent; the other
 * keys are accepted but resolve to emerald. Removed in Phase 3.
 */
export type AccentKey =
  | 'emerald'
  | 'purple'
  | 'ocean'
  | 'amber'
  | 'rose'
  | 'slate'
  | 'custom';

export type Theme = {
  isDark: boolean;
  bg: {
    base: string;
    secondary: string;
    surface: string;
    surfaceHigh: string;
    surfaceSunken: string;
  };
  accent: {
    primary: string;
    hover: string;
    dim: string;
    glow: string;
    subtle: string;
    onPrimary: string;
    primarySoft: string;
    primaryGlow: string;
    gradient: [string, string];
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    tertiary: string;
    onAccent: string;
  };
  border: {
    subtle: string;
    strong: string;
    hover: string;
    accent: string;
  };
  status: {
    success: string;
    warning: string;
    error: string;
    errorDim: string;
  };
  overlay: {
    scrim: string;
    glass: string;
  };
};

export const DARK_THEME: Theme = {
  isDark: true,
  bg: {
    base: '#0a0a0a',
    secondary: '#111111',
    surface: '#171717',
    surfaceHigh: '#222222',
    surfaceSunken: '#0e0e0e',
  },
  accent: {
    primary: '#10b981',
    hover: '#34d399',
    dim: '#059669',
    glow: 'rgba(16, 185, 129, 0.12)',
    subtle: 'rgba(16, 185, 129, 0.06)',
    onPrimary: '#000000',
    primarySoft: '#059669',
    primaryGlow: '#34d399',
    gradient: ['#10b981', '#34d399'],
  },
  text: {
    primary: '#f0f0f0',
    secondary: '#999999',
    muted: '#4a4a4a',
    tertiary: '#4a4a4a',
    onAccent: '#000000',
  },
  border: {
    subtle: '#222222',
    strong: '#333333',
    hover: '#333333',
    accent: 'rgba(16, 185, 129, 0.4)',
  },
  status: {
    success: '#22c55e',
    warning: '#f59e0b',
    error: '#ef4444',
    errorDim: 'rgba(239, 68, 68, 0.1)',
  },
  overlay: {
    scrim: 'rgba(0, 0, 0, 0.55)',
    glass: 'rgba(23, 23, 23, 0.6)',
  },
};

export const LIGHT_THEME: Theme = {
  isDark: false,
  bg: {
    base: '#f5f5f5',
    secondary: '#ebebeb',
    surface: '#ffffff',
    surfaceHigh: '#e2e2e2',
    surfaceSunken: '#f0f0f0',
  },
  accent: {
    primary: '#059669',
    hover: '#047857',
    dim: '#10b981',
    glow: 'rgba(5, 150, 105, 0.15)',
    subtle: 'rgba(5, 150, 105, 0.05)',
    onPrimary: '#ffffff',
    primarySoft: '#10b981',
    primaryGlow: '#10b981',
    gradient: ['#059669', '#047857'],
  },
  text: {
    primary: '#111111',
    secondary: '#555555',
    muted: '#999999',
    tertiary: '#999999',
    onAccent: '#ffffff',
  },
  border: {
    subtle: '#dcdcdc',
    strong: '#c4c4c4',
    hover: '#c4c4c4',
    accent: 'rgba(5, 150, 105, 0.35)',
  },
  status: {
    success: '#16a34a',
    warning: '#d97706',
    error: '#dc2626',
    errorDim: 'rgba(220, 38, 38, 0.08)',
  },
  overlay: {
    scrim: 'rgba(0, 0, 0, 0.35)',
    glass: 'rgba(255, 255, 255, 0.72)',
  },
};

export function resolveTheme(isDark: boolean): Theme {
  return isDark ? DARK_THEME : LIGHT_THEME;
}

// ── Legacy compatibility shims (removed in Phase 3) ───────────────────────
//
// The pre-redesign Settings screen offered multi-accent + custom-hue picking.
// Desktop has a single emerald accent, so those features go away. These
// exports let the existing screens compile until they are replaced.

export type Palette = {
  key: AccentKey;
  label: string;
  hue: number;
  saturation: number;
};

export const PRESET_PALETTES: Palette[] = [
  { key: 'emerald', label: 'Emerald', hue: 160, saturation: 82 },
];

export function paletteFromKey(_key: AccentKey, _h?: number, _s?: number): Palette {
  return PRESET_PALETTES[0];
}

export function buildTheme(_palette: Palette, isDark: boolean): Theme {
  return resolveTheme(isDark);
}
