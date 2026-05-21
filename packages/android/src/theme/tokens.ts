/**
 * Convert-X Android design tokens — spacing, radius, typography, motion.
 *
 * Sourced from the desktop Convert-X stylesheet
 * (Convert-X/packages/shared/src/assets/styles.css) and the actual
 * padding/gap/font-size values used inside the Svelte components.
 * Change here in lockstep with the desktop CSS.
 */

// Desktop uses html font-size 16px, so rem → px = rem * 16.
// Values below are the literal rem sizes the Svelte components use.
export const fontSizes = {
  xxs: 9.3,    // 0.58rem — gif preset description
  xs: 10.9,    // 0.68rem — chips, micro labels
  sm: 11.5,    // 0.72rem — section labels, table headers
  smPlus: 11.8, // 0.74rem — file role badges
  base: 12.5,  // 0.78rem — tabs, default UI text
  bodySm: 13.1, // 0.82rem — input values, button labels
  body: 13.6,  // 0.85rem — primary copy, convert button
  bodyLg: 14.1, // 0.88rem — textareas
  bodyXl: 14.4, // 0.9rem  — desktop-download card title
  md: 16,      // 1rem    — dropzone title
  lg: 17.6,    // 1.1rem  — section h2
  lgPlus: 18.4, // 1.15rem — done panel h2
  xl: 20.8,    // 1.3rem  — Convert-X wordmark
  xxl: 22.4,   // 1.4rem  — progress percentage
} as const;

export const fontWeights = {
  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

export const fontFamily = {
  // Loaded via expo-font in App.tsx — these names match what useFonts() registers.
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semibold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
};

/**
 * Composed typography rules — apply with `...typography.<key>` inside a
 * StyleSheet entry. Mirrors how the desktop components style each role.
 */
export const typography = {
  // Wordmark in the header — 1.3rem, -0.03em letter spacing
  display: {
    fontFamily: fontFamily.bold,
    fontSize: fontSizes.xl,
    fontWeight: fontWeights.bold,
    letterSpacing: -0.6,
  },
  // ProgressBar percentage — 1.4rem
  hero: {
    fontFamily: fontFamily.bold,
    fontSize: fontSizes.xxl,
    fontWeight: fontWeights.bold,
    letterSpacing: -0.4,
  },
  // h2 inside DownloadView / Credits
  title: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.semibold,
    letterSpacing: -0.3,
  },
  // Output panel "Done!" h2 — 1.15rem
  titleAlt: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.lgPlus,
    fontWeight: fontWeights.semibold,
    letterSpacing: -0.3,
  },
  // Dropzone main label — 1rem
  bodyLg: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes.md,
    fontWeight: fontWeights.medium,
    letterSpacing: -0.2,
  },
  // Convert button / primary body — 0.85rem
  body: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes.body,
    fontWeight: fontWeights.medium,
    letterSpacing: -0.1,
  },
  bodyEmph: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.body,
    fontWeight: fontWeights.semibold,
    letterSpacing: -0.1,
  },
  // Inputs / button labels — 0.82rem
  bodySm: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes.bodySm,
    fontWeight: fontWeights.medium,
    letterSpacing: -0.1,
  },
  // Tabs / file row text — 0.78rem semibold
  base: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.base,
    fontWeight: fontWeights.semibold,
    letterSpacing: 0,
  },
  // 0.72rem
  caption: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes.sm,
    fontWeight: fontWeights.medium,
  },
  // Pre-redesign legacy aliases
  headline: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.lg,
    fontWeight: fontWeights.semibold,
    letterSpacing: -0.2,
  },
  label: {
    fontFamily: fontFamily.semibold,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.semibold,
    letterSpacing: 0.4,
    textTransform: 'uppercase' as const,
  },
  // 0.68rem
  micro: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes.xs,
    fontWeight: fontWeights.medium,
  },
  // 0.58rem
  tiny: {
    fontFamily: fontFamily.medium,
    fontSize: fontSizes.xxs,
    fontWeight: fontWeights.medium,
  },
} as const;

/**
 * Desktop uses 14 / 10 / 6 (--radius / --radius-sm / --radius-xs).
 * `lg/xl/round` are legacy aliases for code written prior to the redesign.
 */
export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 14,
  xl: 14,
  round: 999,
} as const;

/**
 * Spacing rhythm pulled from desktop's actual padding/gap values
 * (4 / 5 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 32).
 */
export const spacing = {
  xxs: 2,
  xs: 4,
  pico: 5,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 14,
  xxxl: 16,
  huge: 20,
  giant: 24,
  // Larger steps for code written pre-redesign
  hugeAlt: 32,
} as const;

/**
 * Desktop uses 0.15s cubic-bezier(0.4, 0, 0.2, 1) for fast UI (tab swap,
 * hover) and 0.25 / 0.35s for everything else. We approximate the cubic
 * curve with RN's spring presets; spring's resting state matches the same
 * final position.
 */
export const motion = {
  spring: {
    soft: { damping: 18, stiffness: 160, mass: 1 },
    snappy: { damping: 20, stiffness: 280, mass: 1 },
    gentle: { damping: 22, stiffness: 110, mass: 1 },
  },
  timing: {
    fast: 150,   // --transition-fast
    base: 250,   // --transition
    slow: 350,   // body / theme transition
  },
  // Reanimated `Easing.bezier(...)` accepts these tuples.
  bezier: {
    standard: [0.4, 0, 0.2, 1] as const,
    bounce: [0.34, 1.56, 0.64, 1] as const,
  },
} as const;

/**
 * Elevation — desktop uses subtle 1–4px shadows. The values below feed
 * RN `elevation` on Android and approximate the same depth via shadow offsets.
 */
export const elevation = {
  none: 0,
  low: 1,    // 0 1px 4px rgba(0,0,0,0.12) — active tab
  medium: 4, // 0 4px 10px rgba(0,0,0,0.25)
  high: 8,   // 0 8px 24px rgba(0,0,0,0.30) — modal lift
} as const;
