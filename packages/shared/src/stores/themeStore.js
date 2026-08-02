import { writable } from "svelte/store";
import { loadJson, saveJson } from "../lib/storage.js";
import { darken, lighten, normalizeHex, readableOn, rgba } from "../lib/color.js";

/**
 * Theme state for both desktop and web.
 *
 * Two independent axes:
 *  - `theme`  — the light/dark colour scheme (unchanged public API).
 *  - `accent` — an optional user-picked accent hex that overrides the stock
 *               emerald. Applied by writing CSS custom properties onto
 *               :root, so every `var(--accent*)` in the app re-themes live.
 *
 * Port of the Android ThemeProvider (accent + quick picks + auto-add), with
 * the accent cluster derived by the same maths (lib/color.js ⇄ android
 * lib/color.ts, buildAccent in android theme/palettes.ts).
 *
 * Pure localStorage + CSS — no platform adapter calls, so it is identical on
 * desktop and web.
 */

// Legacy key, deliberately unchanged: renaming it would drop every existing
// install back to dark mode. New state uses the convertx.*.v1 convention.
const SCHEME_KEY = "convertx-theme";
const ACCENT_KEY = "convertx.accent.v1";

/** Cap on the editable quick-picks row. */
export const QUICK_PICKS_MAX = 12;

/** Seed swatches for a fresh install (same set as Android). */
export const DEFAULT_QUICK_PICKS = [
  "#10b981", "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899",
  "#f43f5e", "#f97316", "#f59e0b", "#06b6d4", "#84cc16",
];

/**
 * The stock accent per scheme — mirrors assets/styles.css. With no override
 * these are what the stylesheet paints, so the UI (swatch dot, "selected"
 * check) has to compare against the scheme's own default.
 */
const STOCK_ACCENT = { dark: "#10b981", light: "#059669" };

/** The scheme-independent "default" swatch shown in the picks row. */
export const DEFAULT_ACCENT = STOCK_ACCENT.dark;

export function stockAccent(scheme) {
  return scheme === "light" ? STOCK_ACCENT.light : STOCK_ACCENT.dark;
}

/** Every custom property the accent override writes (and clears on reset). */
const ACCENT_VARS = [
  "--accent",
  "--accent-hover",
  "--accent-dim",
  "--accent-glow",
  "--accent-subtle",
  "--accent-border",
  "--btn-primary-text",
];

function dedupeCap(list, max) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const hex = normalizeHex(c);
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Derive the full accent cluster from one base hex. Mirrors the hand-tuned
 * stock palettes per scheme: dark lightens for hover / darkens for dim, light
 * does the inverse; glow/subtle/border alphas differ by scheme too.
 * (android theme/palettes.ts buildAccent + resolveTheme.)
 */
export function buildAccentVars(hex, isDark) {
  const hover = isDark ? lighten(hex, 0.18) : darken(hex, 0.18);
  const dim = isDark ? darken(hex, 0.16) : lighten(hex, 0.16);
  return {
    "--accent": hex,
    "--accent-hover": hover,
    "--accent-dim": dim,
    "--accent-glow": rgba(hex, isDark ? 0.12 : 0.15),
    "--accent-subtle": rgba(hex, isDark ? 0.06 : 0.05),
    "--accent-border": rgba(hex, isDark ? 0.4 : 0.35),
    // Text/icons drawn on top of a filled accent surface.
    "--btn-primary-text": readableOn(hex),
  };
}

/**
 * Paint (or clear) the accent override. Inline properties on :root outrun
 * both [data-theme] blocks in styles.css, so one call re-themes light and
 * dark alike; removing them falls back to the stylesheet's stock palette.
 */
function applyAccent(scheme, hex) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const norm = normalizeHex(hex);
  if (!norm) {
    for (const v of ACCENT_VARS) root.style.removeProperty(v);
  } else {
    const vars = buildAccentVars(norm, scheme !== "light");
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }
  // Keep the browser/OS chrome tint in step with the accent (web PWA + the
  // Android Chrome address bar); harmless when the tag is absent.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", norm || stockAccent(scheme));
}

function loadScheme() {
  try {
    if (typeof localStorage === "undefined") return "dark";
    return localStorage.getItem(SCHEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function loadAccent() {
  const raw = loadJson(ACCENT_KEY, null) || {};
  const picks = Array.isArray(raw.quickPicks) ? dedupeCap(raw.quickPicks, QUICK_PICKS_MAX) : [];
  return {
    color: normalizeHex(raw.color),
    quickPicks: picks.length ? picks : [...DEFAULT_QUICK_PICKS],
    quickPicksAuto: raw.quickPicksAuto !== false,
  };
}

const initialScheme = loadScheme();
const initialAccent = loadAccent();

function createThemeStore() {
  const { subscribe, set } = writable(initialScheme);

  function apply(value) {
    const next = value === "light" ? "light" : "dark";
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", next);
    }
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(SCHEME_KEY, next);
    } catch {
      // non-fatal (quota, private mode)
    }
    // hover/dim/glow are scheme-dependent, so a mode switch re-derives them.
    applyAccent(next, currentAccent.color);
    set(next);
    currentScheme = next;
    return next;
  }

  return {
    subscribe,
    toggle() {
      apply(currentScheme === "dark" ? "light" : "dark");
    },
    set(value) {
      apply(value);
    },
  };
}

function createAccentStore() {
  const { subscribe, set } = writable(initialAccent);

  function commit(next) {
    currentAccent = next;
    saveJson(ACCENT_KEY, next);
    set(next);
  }

  return {
    subscribe,

    /** Commit an accent (null → back to the stock per-scheme emerald). */
    setColor(hex) {
      const norm = normalizeHex(hex);
      const next = { ...currentAccent, color: norm };
      // Last-used lands at the front of the quick-picks row when auto is on.
      if (norm && currentAccent.quickPicksAuto) {
        next.quickPicks = dedupeCap([norm, ...currentAccent.quickPicks], QUICK_PICKS_MAX);
      }
      applyAccent(currentScheme, norm);
      commit(next);
    },

    /**
     * Re-theme live WITHOUT persisting — for the picker while dragging.
     * Commit the settled value with setColor().
     */
    preview(hex) {
      const norm = normalizeHex(hex);
      if (currentAccent.color === norm) return;
      currentAccent = { ...currentAccent, color: norm };
      applyAccent(currentScheme, norm);
      set(currentAccent);
    },

    /** Replace the editable quick-picks row (remove / add / reorder). */
    setQuickPicks(list) {
      commit({ ...currentAccent, quickPicks: dedupeCap(list, QUICK_PICKS_MAX) });
    },

    /** Toggle auto-adding the last-committed colour to quick picks. */
    setQuickPicksAuto(on) {
      commit({ ...currentAccent, quickPicksAuto: !!on });
    },

    /** Back to the stock accent AND the seed swatch row. */
    resetAll() {
      applyAccent(currentScheme, null);
      commit({ color: null, quickPicks: [...DEFAULT_QUICK_PICKS], quickPicksAuto: true });
    },
  };
}

// Mirrors of the two stores' current values — the stores read each other
// (a scheme flip re-derives the accent cluster) and subscribing to yourself
// inside a store factory is circular.
let currentScheme = initialScheme;
let currentAccent = initialAccent;

export const theme = createThemeStore();
export const accent = createAccentStore();

// Paint the persisted state on module load, before the first render.
if (typeof document !== "undefined") {
  document.documentElement.setAttribute("data-theme", initialScheme);
  applyAccent(initialScheme, initialAccent.color);
}
