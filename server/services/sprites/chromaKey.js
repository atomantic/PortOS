/**
 * Sprites — dynamic chroma-key selection (issue #2896, phase 2).
 *
 * The source pipeline hardcoded magenta because its one character wore green;
 * per the #2895 decision the key is now picked per character from a FIXED set
 * of three standard keys, by hue distance from the character's own palette
 * (a green-clothed character keys on magenta; a pink one keys on green/blue).
 *
 * Pure module — palette extraction (sharp) lives in normalize.js; this file
 * is just color math so it stays unit-testable and safe to import anywhere.
 */

export const CHROMA_KEYS = [
  { hex: '#FF00FF', name: 'magenta', hue: 300 },
  { hex: '#00FF00', name: 'green', hue: 120 },
  { hex: '#0000FF', name: 'blue', hue: 240 },
];

export const CHROMA_KEY_HEXES = CHROMA_KEYS.map((k) => k.hex);

// Magenta — the source pipeline's only key; the fallback wherever no key has
// been selected yet (pre-lock generation, legacy imports).
export const DEFAULT_CHROMA_KEY = CHROMA_KEYS[0].hex;

// Below this hue separation (degrees) between the chosen key and the nearest
// significant palette color, keying will likely eat character pixels — the
// selection still returns the best key but carries a warning.
export const MIN_HUE_SEPARATION = 60;

export function rgbToHsv(r, g, b) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Pick the key whose hue is farthest from every significant color in the
 * character's palette.
 *
 * `palette` is `[{ r, g, b, count }]` (see extractForegroundPalette). Colors
 * below the saturation/value floors are ignored — near-grays and near-blacks
 * have no meaningful hue and never conflict with a saturated key; colors
 * below `minCountFrac` of the total are single-pixel noise.
 *
 * Returns `{ hex, name, minHueDistance, warning }` — never null; a fully
 * achromatic palette conflicts with nothing, so the first key (magenta, the
 * legacy default) wins with distance Infinity.
 */
export function pickChromaKey(palette, {
  minCountFrac = 0.005,
  minSaturation = 0.25,
  minValue = 0.15,
} = {}) {
  const entries = Array.isArray(palette) ? palette : [];
  const total = entries.reduce((sum, e) => sum + (e.count || 0), 0);
  const significant = entries
    .map((e) => ({ ...rgbToHsv(e.r, e.g, e.b), count: e.count || 0 }))
    .filter((c) => c.count >= total * minCountFrac && c.s >= minSaturation && c.v >= minValue);

  let best = null;
  for (const key of CHROMA_KEYS) {
    const minDist = significant.length
      ? Math.min(...significant.map((c) => hueDistance(key.hue, c.h)))
      : Infinity;
    if (!best || minDist > best.minHueDistance) {
      best = { hex: key.hex, name: key.name, minHueDistance: minDist };
    }
  }
  return {
    ...best,
    warning: best.minHueDistance < MIN_HUE_SEPARATION
      ? `Closest palette hue is within ${Math.round(best.minHueDistance)}° of the ${best.name} key — keying may clip character pixels`
      : null,
  };
}
