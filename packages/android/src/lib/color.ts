/**
 * Small color helpers for deriving an accent palette from a single base hex.
 * Pure functions, no theme deps — so palettes.ts can build a full accent
 * cluster (hover / dim / glow / subtle / onPrimary) from any chosen color.
 */

/** Validate + normalize loose input ("7c3aed", "#ABC", "#7C3AED") to "#rrggbb", or null. */
export function normalizeHex(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/.test(s) ? `#${s}` : null;
}

function toRgb(hex: string): { r: number; g: number; b: number } {
  const s = hex.replace(/^#/, '');
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** "rgba(r, g, b, a)" from a hex + alpha (0..1). */
export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = toRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Mix toward white by amount (0..1). */
export function lighten(hex: string, amount: number): string {
  const { r, g, b } = toRgb(hex);
  return toHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

/** Mix toward black by amount (0..1). */
export function darken(hex: string, amount: number): string {
  const { r, g, b } = toRgb(hex);
  return toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

/** HSV (h: 0..360, s/v: 0..1) → "#rrggbb". Inputs are clamped/wrapped. */
export function hsvToHex(h: number, s: number, v: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.min(1, Math.max(0, s));
  v = Math.min(1, Math.max(0, v));
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** "#rrggbb" (or loose hex) → {h: 0..360, s: 0..1, v: 0..1}, or null if invalid. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  const { r, g, b } = toRgb(norm);
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rf) h = 60 * (((gf - bf) / d) % 6);
    else if (max === gf) h = 60 * ((bf - rf) / d + 2);
    else h = 60 * ((rf - gf) / d + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

/** Black or white — whichever stays legible as text/icons on top of `hex`. */
export function readableOn(hex: string): '#000000' | '#ffffff' {
  const { r, g, b } = toRgb(hex);
  const lin = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.34 ? '#000000' : '#ffffff';
}
