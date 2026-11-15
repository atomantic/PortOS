/** "Make it vertical": ratio table, 720-wide target size and the blurred-fill ffmpeg graph that re-frames a landscape clip onto a tall canvas without cropping it. */

export const VERTICAL_REFRAME_WIDTH = 720;

// Output ratios, tallest first. `w`/`h` are the ratio terms, not pixels.
export const VERTICAL_RATIOS = Object.freeze({
  '9:16': Object.freeze({ w: 9, h: 16 }),
  '4:5': Object.freeze({ w: 4, h: 5 }),
  '1:1': Object.freeze({ w: 1, h: 1 }),
});
export const VERTICAL_RATIO_IDS = Object.freeze(Object.keys(VERTICAL_RATIOS));

const even = (n) => Math.round(n / 2) * 2;

/** Output pixel size for `ratioId` at 720 wide, both sides even for yuv420p. Null for an unknown ratio. */
export function verticalTargetSize(ratioId) {
  const ratio = VERTICAL_RATIOS[ratioId];
  if (!ratio) return null;
  return { width: VERTICAL_REFRAME_WIDTH, height: even((VERTICAL_REFRAME_WIDTH * ratio.h) / ratio.w) };
}

/**
 * A clip whose own aspect is already as tall as (or taller than) the target has
 * nothing to fill: the fit-to-width foreground would be at least the canvas
 * height and the background would never show.
 */
export function isAlreadyTallEnough(srcWidth, srcHeight, ratioId) {
  const ratio = VERTICAL_RATIOS[ratioId];
  if (!ratio || !(srcWidth > 0) || !(srcHeight > 0)) return false;
  return srcWidth * ratio.h <= srcHeight * ratio.w;
}

/**
 * The `-filter_complex` graph: the whole clip centred at canvas width over a
 * scaled-to-cover, boxblurred, slightly dimmed copy of itself. The blur radius
 * scales with canvas width. Output label is `outv`.
 */
export function verticalFilterGraph(ratioId) {
  const size = verticalTargetSize(ratioId);
  if (!size) return null;
  const { width, height } = size;
  const blur = Math.max(2, Math.round(width / 24));
  return [
    '[0:v]split=2[bgsrc][fgsrc]',
    `[bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=${blur}:2,eq=brightness=-0.12[bg]`,
    `[fgsrc]scale=${width}:-2[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[outv]',
  ].join(';');
}
