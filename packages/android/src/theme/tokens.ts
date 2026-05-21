/**
 * Design tokens: spacing, radius, typography, motion.
 * Not tied to a palette — these are immutable.
 */

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

export const radius = {
  xs: 6,
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  round: 999,
} as const;

export const typography = {
  display: {
    fontSize: 32,
    fontWeight: '700' as const,
    letterSpacing: -0.8,
    lineHeight: 38,
  },
  title: {
    fontSize: 22,
    fontWeight: '600' as const,
    letterSpacing: -0.4,
    lineHeight: 28,
  },
  headline: {
    fontSize: 18,
    fontWeight: '600' as const,
    letterSpacing: -0.2,
    lineHeight: 24,
  },
  body: {
    fontSize: 15,
    fontWeight: '400' as const,
    letterSpacing: -0.1,
    lineHeight: 22,
  },
  bodyEmph: {
    fontSize: 15,
    fontWeight: '500' as const,
    letterSpacing: -0.1,
    lineHeight: 22,
  },
  caption: {
    fontSize: 13,
    fontWeight: '400' as const,
    letterSpacing: 0,
    lineHeight: 18,
  },
  label: {
    fontSize: 12,
    fontWeight: '600' as const,
    letterSpacing: 0.4,
    lineHeight: 16,
    textTransform: 'uppercase' as const,
  },
  micro: {
    fontSize: 11,
    fontWeight: '500' as const,
    letterSpacing: 0.2,
    lineHeight: 14,
  },
} as const;

export const motion = {
  // Spring physics — the whole app should feel like this
  spring: {
    soft: { damping: 18, stiffness: 160, mass: 1 },
    snappy: { damping: 20, stiffness: 280, mass: 1 },
    gentle: { damping: 22, stiffness: 110, mass: 1 },
  },
  timing: {
    fast: 180,
    base: 240,
    slow: 360,
  },
} as const;

export const elevation = {
  none: 0,
  low: 2,
  medium: 6,
  high: 12,
} as const;
