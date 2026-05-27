/**
 * Convert-X Android color tokens.
 *
 * 1:1 mirror of the desktop Convert-X palette
 * (Convert-X/packages/shared/src/assets/styles.css). Dark = near-black with
 * emerald accent. Light = bone-white with deep emerald. When changing here,
 * change the desktop CSS in lockstep.
 */

import { darken, lighten, normalizeHex, readableOn, rgba } from '../lib/color';

export type ColorScheme = 'light' | 'dark' | 'system';

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
    /** Slider track + small gradient touches — kept for the Slider component. */
    gradient: [string, string];
    // Legacy aliases preserved for the Slider component (Phase 1/2 holdover).
    primarySoft: string;
    primaryGlow: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    /** Alias for muted — older code paths still reference it. */
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
    /** Low-alpha tint for any future BlurView; not used in flat-styling layout. */
    blurTint: string;
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
    gradient: ['#10b981', '#34d399'],
    primarySoft: '#059669',
    primaryGlow: '#34d399',
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
    blurTint: 'rgba(23, 23, 23, 0.6)',
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
    gradient: ['#059669', '#047857'],
    primarySoft: '#10b981',
    primaryGlow: '#10b981',
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
    blurTint: 'rgba(255, 255, 255, 0.72)',
  },
};

/**
 * Build the full accent cluster from a single base color — used when the user
 * overrides the default emerald with their own. Shades and the on-accent text
 * color are derived so buttons/labels stay legible on any hue.
 */
function buildAccent(base: string): Theme['accent'] {
  const hover = lighten(base, 0.18);
  const dim = darken(base, 0.16);
  return {
    primary: base,
    hover,
    dim,
    glow: rgba(base, 0.12),
    subtle: rgba(base, 0.06),
    onPrimary: readableOn(base),
    gradient: [base, hover],
    primarySoft: dim,
    primaryGlow: hover,
  };
}

/**
 * Resolve the active theme. A valid `accentColor` (hex like "#7c3aed") overrides
 * the default emerald accent everywhere; null/undefined/invalid → stock palette.
 */
export function resolveTheme(isDark: boolean, accentColor?: string | null): Theme {
  const base = isDark ? DARK_THEME : LIGHT_THEME;
  const hex = normalizeHex(accentColor);
  if (!hex) return base;
  const accent = buildAccent(hex);
  return {
    ...base,
    accent,
    border: { ...base.border, accent: rgba(hex, 0.4) },
    text: { ...base.text, onAccent: accent.onPrimary },
  };
}
