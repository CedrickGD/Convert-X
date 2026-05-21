/**
 * Convert-X palette system.
 *
 * Each accent is built from a single HSL seed. Dark and light schemes
 * derive neutrals from that seed so every palette feels cohesive, not pasted.
 */

export type AccentKey =
  | 'purple'
  | 'ocean'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'slate'
  | 'custom';

export type ColorScheme = 'light' | 'dark' | 'system';

export type Palette = {
  key: AccentKey;
  label: string;
  hue: number; // 0-360
  saturation: number; // 0-100
};

export const PRESET_PALETTES: Palette[] = [
  { key: 'purple', label: 'Amethyst', hue: 271, saturation: 91 },
  { key: 'ocean', label: 'Ocean', hue: 201, saturation: 92 },
  { key: 'emerald', label: 'Emerald', hue: 160, saturation: 82 },
  { key: 'amber', label: 'Amber', hue: 38, saturation: 92 },
  { key: 'rose', label: 'Rose', hue: 346, saturation: 78 },
  { key: 'slate', label: 'Graphite', hue: 215, saturation: 18 },
];

/** A resolved theme: every color needed to render the app. */
export type Theme = {
  isDark: boolean;
  accent: {
    // brand
    primary: string;
    primarySoft: string;
    primaryGlow: string;
    onPrimary: string;
    gradient: [string, string];
  };
  bg: {
    base: string; // page background
    surface: string; // cards, sheets
    surfaceHigh: string; // elevated cards / hovered
    surfaceSunken: string; // input fields
  };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    onAccent: string;
  };
  border: {
    subtle: string;
    strong: string;
    accent: string;
  };
  status: {
    success: string;
    warning: string;
    error: string;
  };
  overlay: {
    scrim: string;
    glass: string; // tint for BlurView
  };
};

// ────────────────────────────────────────────────────────────
// HSL → hex helpers
// ────────────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}

function hslToHex(h: number, s: number, l: number): string {
  const sPct = clamp(s) / 100;
  const lPct = clamp(l) / 100;
  const c = (1 - Math.abs(2 * lPct - 1)) * sPct;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lPct - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (n: number) =>
    Math.round((n + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function hsla(h: number, s: number, l: number, a: number): string {
  return `hsla(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%, ${a})`;
}

// ────────────────────────────────────────────────────────────
// Theme derivation
// ────────────────────────────────────────────────────────────

export function buildTheme(palette: Palette, isDark: boolean): Theme {
  const h = palette.hue;
  const s = palette.saturation;

  if (isDark) {
    // Neutrals lean cool-dark, tinted by the accent hue
    const neutralS = Math.min(s * 0.15, 14);
    return {
      isDark: true,
      accent: {
        primary: hslToHex(h, s, 65),
        primarySoft: hslToHex(h, clamp(s - 10), 32),
        primaryGlow: hslToHex(h, s, 72),
        onPrimary: '#FFFFFF',
        gradient: [hslToHex(h, s, 70), hslToHex((h + 22) % 360, clamp(s - 4), 58)],
      },
      bg: {
        base: hslToHex(h, neutralS, 6),
        surface: hslToHex(h, neutralS, 10),
        surfaceHigh: hslToHex(h, neutralS, 14),
        surfaceSunken: hslToHex(h, neutralS, 8),
      },
      text: {
        primary: hslToHex(h, 12, 96),
        secondary: hslToHex(h, 10, 74),
        tertiary: hslToHex(h, 10, 54),
        onAccent: '#FFFFFF',
      },
      border: {
        subtle: hsla(h, 18, 60, 0.08),
        strong: hsla(h, 18, 60, 0.16),
        accent: hsla(h, s, 65, 0.4),
      },
      status: {
        success: hslToHex(152, 68, 52),
        warning: hslToHex(38, 92, 62),
        error: hslToHex(0, 78, 62),
      },
      overlay: {
        scrim: 'rgba(0,0,0,0.55)',
        glass: hsla(h, neutralS, 12, 0.6),
      },
    };
  }

  // Light
  const neutralS = Math.min(s * 0.12, 10);
  return {
    isDark: false,
    accent: {
      primary: hslToHex(h, clamp(s - 4), 52),
      primarySoft: hslToHex(h, clamp(s - 8), 92),
      primaryGlow: hslToHex(h, s, 58),
      onPrimary: '#FFFFFF',
      gradient: [hslToHex(h, s, 56), hslToHex((h + 18) % 360, clamp(s - 2), 50)],
    },
    bg: {
      base: hslToHex(h, neutralS, 98),
      surface: '#FFFFFF',
      surfaceHigh: hslToHex(h, neutralS, 99),
      surfaceSunken: hslToHex(h, neutralS, 95),
    },
    text: {
      primary: hslToHex(h, 30, 8),
      secondary: hslToHex(h, 14, 30),
      tertiary: hslToHex(h, 12, 52),
      onAccent: '#FFFFFF',
    },
    border: {
      subtle: hsla(h, 18, 30, 0.08),
      strong: hsla(h, 18, 30, 0.18),
      accent: hsla(h, s, 52, 0.35),
    },
    status: {
      success: hslToHex(152, 64, 38),
      warning: hslToHex(38, 92, 46),
      error: hslToHex(0, 70, 48),
    },
    overlay: {
      scrim: 'rgba(10,4,22,0.35)',
      glass: hsla(h, neutralS, 99, 0.72),
    },
  };
}

export function paletteFromKey(key: AccentKey, customHue = 271, customSat = 90): Palette {
  if (key === 'custom') {
    return { key: 'custom', label: 'Custom', hue: customHue, saturation: customSat };
  }
  return PRESET_PALETTES.find((p) => p.key === key) ?? PRESET_PALETTES[0];
}
