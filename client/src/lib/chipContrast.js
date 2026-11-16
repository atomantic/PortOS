// Contrast-safe chip colors for arbitrary, externally-supplied colors — forge
// issue-label hexes being the first consumer (`IssuesTab`).
//
// The problem this solves: a forge label color is repo data, picked by whoever
// created the label with no idea which PortOS theme it will land on. Rendering
// it verbatim as chip text works on the night themes it was eyeballed against
// and falls apart on the day themes — GitHub's default pale yellows/greens
// (`plan` at #fef2c0, `effort:*` at similar tints) come out as white-on-cream,
// i.e. invisible. The mirror failure exists on night themes for a very dark
// label color.
//
// The fix keeps the label's HUE (the thing the user recognizes it by) and moves
// only its LIGHTNESS, by the smallest step that clears WCAG AA against the chip's
// own tinted backdrop. A label already legible on the active mode is returned
// untouched.
//
// Referentially transparent: the caller passes the active theme `mode`
// (`'day' | 'night'`, from `useThemeContext().theme.mode`) and nothing here reads
// the DOM. The only state is a bounded memo of results, since the same handful
// of label colors is graded on every row of every render.

import { THEMES } from '../themes/portosThemes.js';
import { clamp } from '../utils/formatters.js';
import { evictOldest } from './boundedMap.js';

// `"234 228 219"` (the `--port-*` color-var form) → `{ r, g, b }` (NaN channels
// for anything else — callers validate with Number.isFinite).
export const parseTriple = (triple) => {
  const [r, g, b] = String(triple).trim().split(/\s+/).map(Number);
  return { r, g, b };
};

// Chip background is a low-alpha wash of the ORIGINAL color (so the tint still
// reads as that label's hue) and the border a stronger one of the adjusted color.
export const WASH_ALPHA = 0.16;
export const BORDER_ALPHA = 0.4;

// WCAG 2.1 AA for normal text.
const MIN_CONTRAST = 4.5;

const byte = (n) => clamp(Math.round(n), 0, 255);

/**
 * Parse a color into `{ r, g, b }` (0–255), or null when it isn't a form we can
 * reason about. Handles `#rgb`, `#rrggbb`, bare hex with no `#` (what the GitHub
 * API returns before `appIssues.js` prefixes it), and `rgb()`/`rgba()` (what a
 * browser hands back when reading an inline style). Named CSS colors and `hsl()`
 * return null — the caller falls back to a neutral chip rather than shipping an
 * unreadable guess.
 */
export function parseColor(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return { r: clamp(parts[0], 0, 255), g: clamp(parts[1], 0, 255), b: clamp(parts[2], 0, 255) };
  }

  // Expand `#rgb` shorthand by doubling each nibble, then parse the one 6-digit form.
  const hex = value.replace(/^#/, '').replace(/^[0-9a-f]{3}$/, (m) => m.replace(/./g, (c) => c + c));
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** `{ r, g, b }` → `#rrggbb`. */
const toHex = ({ r, g, b }) => `#${[r, g, b].map((n) => byte(n).toString(16).padStart(2, '0')).join('')}`;

/** `{ r, g, b }` + alpha → `rgba(r, g, b, a)`. */
const toRgba = ({ r, g, b }, alpha) => `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${alpha})`;

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }) {
  const channel = (n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The WORST-case chip surface in each theme mode, derived from the shipped
 * themes rather than hand-copied: the darkest surface a `day` theme puts a chip
 * on (dark text needs the most help there) and the lightest a `night` theme
 * does. Grading against these means every other surface of that mode lands with
 * MORE contrast, never less — and a newly added theme is covered automatically
 * instead of silently escaping the guarantee.
 *
 * Both `--port-bg` and `--port-card` count: a chip can sit on the page or on a
 * card, so neither may fall outside the reference.
 */
export const SURFACES = Object.values(THEMES).reduce((acc, theme) => {
  const mode = theme.mode === 'day' ? 'day' : 'night';
  for (const token of ['--port-bg', '--port-card']) {
    const surface = parseTriple(theme.colors[token]);
    const worse = mode === 'day'
      ? relativeLuminance(surface) < relativeLuminance(acc[mode])
      : relativeLuminance(surface) > relativeLuminance(acc[mode]);
    if (worse) acc[mode] = surface;
  }
  return acc;
}, { day: { r: 255, g: 255, b: 255 }, night: { r: 0, g: 0, b: 0 } });

/** WCAG contrast ratio between two opaque colors (1–21). */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Composite `fg` at `alpha` over opaque `bg` (source-over). */
export function blend(fg, bg, alpha) {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

/** RGB (0–255) → HSL with h in [0,360), s/l in [0,1]. */
export function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return { h: (h + 360) % 360, s, l };
}

/** HSL (h in [0,360), s/l in [0,1]) → RGB (0–255). */
export function hslToRgb({ h, s, l }) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
      : hp < 3 ? [0, c, x]
        : hp < 4 ? [0, x, c]
          : hp < 5 ? [x, 0, c]
            : [c, 0, x];
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/** What a chip's text actually sits on: the wash of `rgb` over that mode's surface. */
export function chipBackdrop(rgb, mode) {
  return blend(rgb, SURFACES[mode] ?? SURFACES.night, WASH_ALPHA);
}

/**
 * Move `rgb` toward the smallest lightness that clears `MIN_CONTRAST` against
 * `backdrop`, keeping hue and saturation. The direction comes from the backdrop
 * itself — a light backdrop darkens, a dark one lightens — so the surface and
 * the adjustment can never disagree. Returns the input untouched when it already
 * clears; returns the extreme (pure black / pure white for that hue) when nothing
 * in that direction does, since a hue that can't reach AA is still far more
 * legible at the extreme than where it started.
 */
export function ensureReadable(rgb, backdrop) {
  if (contrastRatio(rgb, backdrop) >= MIN_CONTRAST) return rgb;
  const { h, s, l } = rgbToHsl(rgb);
  const step = relativeLuminance(backdrop) > 0.5 ? -0.02 : 0.02;
  let best = rgb;
  for (let next = l + step; next >= 0 && next <= 1; next += step) {
    best = hslToRgb({ h, s, l: next });
    if (contrastRatio(best, backdrop) >= MIN_CONTRAST) return best;
  }
  return best;
}

// A repo's label palette is a few dozen colors that repeat on every row, and the
// lightness search runs up to ~50 iterations per miss — so memoize per
// (color, mode). The cache also hands React a stable `style` object across
// renders, which it can skip diffing. The cap is well above any real palette;
// it only stops a long-lived session from growing the map without bound.
const CACHE_MAX = 512;
const cache = new Map();

/**
 * Chip styles for an arbitrary color under the active theme mode:
 * `{ color, borderColor, backgroundColor }` ready to spread into an inline
 * `style`, or null when the color is missing/unparseable so the caller can fall
 * back to its own neutral chip.
 */
export function chipColors(raw, mode) {
  const key = `${raw}|${mode}`;
  if (cache.has(key)) return cache.get(key);

  const rgb = parseColor(raw);
  // Wash + border stay translucent so they composite against each theme's real
  // surface. Grading happens against the reference surface, which is the worst
  // case for its mode — every other surface of that mode lands with MORE
  // contrast, never less.
  const backdrop = rgb && chipBackdrop(rgb, mode);
  const text = rgb && ensureReadable(rgb, backdrop);
  const style = rgb ? {
    color: toHex(text),
    borderColor: toRgba(text, BORDER_ALPHA),
    backgroundColor: toRgba(rgb, WASH_ALPHA),
  } : null;

  cache.set(key, style);
  evictOldest(cache, CACHE_MAX);
  return style;
}
