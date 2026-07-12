// Shared canvas helpers for the two piano-roll renderers — the Synthesia
// falling-note <PianoRoll> (score playback) and the DAW-style <MidiPianoRoll>
// (transcribed .mid inspection, #2477). Pure canvas math/palette, no React.

// Per-layer/track colors, assigned by index so keyboards, note bars, and
// legends all agree. Bright, distinct hues that read on the near-black canvas.
const LAYER_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#a855f7', '#06b6d4', '#ef4444', '#14b8a6'];
export const layerColor = (index) => LAYER_COLORS[((index % LAYER_COLORS.length) + LAYER_COLORS.length) % LAYER_COLORS.length];

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
