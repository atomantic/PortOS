// Shared canvas helpers for the two piano-roll renderers (`<PianoRoll>` falling-note +
// `<MidiPianoRoll>` DAW-style, #2477).
//
// `layerColor(index)` is the per-layer/track palette (8 hues, wraps both directions) for note bars, keyboards and legends; `roundRect(ctx, x, y, w, h, r)` a rounded-rect path with `ctx.roundRect` feature-detect and arcTo fallback; `rollPalette()` resolves the theme-following `{ bg, accent, accentRgb }` from `--port-accent` via `getComputedStyle` (canvas can't read CSS vars); `ROLL_BG` is the shared near-black bg literal. Pure canvas math/palette, no React.

// Per-layer/track colors, assigned by index so keyboards, note bars, and
// legends all agree. Bright, distinct hues that read on the near-black canvas.
const LAYER_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#a855f7', '#06b6d4', '#ef4444', '#14b8a6'];
export const layerColor = (index) => LAYER_COLORS[((index % LAYER_COLORS.length) + LAYER_COLORS.length) % LAYER_COLORS.length];

// Roll canvas background: a near-black deliberately darker than `--port-bg` (#0f0f0f) so note bars pop, and NOT theme-following (the layer palette is tuned for a near-black roll; a day theme would wash it out). Single source for the literal: canvases paint it via fillStyle and set it as their CSS background (shown before first paint), so never re-type it as a Tailwind arbitrary value.
export const ROLL_BG = '#0c0c0e';
const ACCENT_FALLBACK_RGB = '59 130 246'; // Classic Midnight --port-accent

/**
 * Resolve the roll canvas palette from the active theme. Canvas `fillStyle`
 * can't read CSS custom properties, so we read `--port-accent` once via
 * `getComputedStyle` (mirroring `useChartColors`) and hand back concrete
 * strings. `accentRgb` is the raw space-separated triple so callers can build
 * alpha tints (`rgb(${accentRgb} / 0.25)`); `accent` is the ready-to-use solid.
 * Falls back to the Classic Midnight accent in non-browser/test environments.
 * @returns {{ bg:string, accent:string, accentRgb:string }}
 */
export const rollPalette = () => {
  let accentRgb = ACCENT_FALLBACK_RGB;
  if (typeof window !== 'undefined' && typeof getComputedStyle === 'function') {
    const parts = getComputedStyle(document.documentElement)
      .getPropertyValue('--port-accent').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 3) accentRgb = `${parts[0]} ${parts[1]} ${parts[2]}`;
  }
  return { bg: ROLL_BG, accent: `rgb(${accentRgb})`, accentRgb };
};

// Rounded-rect path with a feature-detect for ctx.roundRect (arcTo fallback
// for older canvas implementations). Callers fill()/stroke() the path.
export const roundRect = (ctx, x, y, w, h, r) => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, rr); return; }
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
};
