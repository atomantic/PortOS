/**
 * Frame-quality scoring — picks the video continuation anchor by measuring candidate frames instead
 * of trusting wherever an end-seek lands.
 *
 * A chained render conditions chunk N+1 on one tail frame of chunk N; local video is motion-heavy, so
 * that frame is often blurred, mid-blink or in a fade, and the blur compounds each hop. Scoring is
 * cheap (`sharp` only): decode each candidate to a raw single-channel buffer, then combine
 *
 *   focus    — log-compressed variance of the first-difference gradient (log keeps one very sharp
 *              frame from swamping exposure).
 *   exposure — penalty on mean-luma distance from mid-grey (rejects fade-to-black / blown highlights).
 *   recency  — small linear preference for later frames, keeping the anchor close to the cut.
 *
 * Usability is separate from ranking: `usable` gates on raw gradient variance alone so only a
 * mathematically degenerate frame is rejected and a dark-but-real tail still qualifies.
 */

// Tail window the candidates are decoded from, and how densely. Capped at the reach of the single
// `-sseof -1.0` seek this replaces: focus tends to be highest at the OLDEST candidate, so a wider
// window would anchor further from the cut at every chain seam; recency alone can't bound it.
export const TAIL_WINDOW_SECONDS = 1.0;
export const CANDIDATE_FPS = 12;
// Derived, never independent: the ffmpeg `-frames:v` cap truncates from the NEWEST end, which the
// recency term prefers, so a disagreement would silently discard the pick.
export const MAX_CANDIDATES = Math.round(TAIL_WINDOW_SECONDS * CANDIDATE_FPS);

// Gradient variance that maps to a focus of 1.0. Real sharp frames land in the
// low thousands, so this leaves headroom without clamping ordinary content.
export const FOCUS_SCALE = 20000;
export const EXPOSURE_WEIGHT = 0.6;
export const RECENCY_WEIGHT = 0.15;

// Gradient variance below which a frame carries no signal (solid fill, fully faded, empty decode).
// `usable` gates on this, NOT the composite score: the exposure penalty would reject a legitimately
// dark tail (mean luma 0.12 alone costs ~0.46) and revert night scenes to the unscored end seek.
// 0.25 is (0.5 levels)^2, below the smallest difference an encoder can represent (cf.
// `SOLID_FILL_STDEV_EPSILON`, `imageFrameStats.js`).
export const MIN_SIGNAL_VARIANCE = 0.25;

const clamp01 = (n) => (n < 0 ? 0 : (n > 1 ? 1 : n));

const isFrame = (frame) => !!frame
  && Number.isInteger(frame.width) && Number.isInteger(frame.height)
  && frame.width > 0 && frame.height > 0
  && frame.data?.length >= frame.width * frame.height;

/**
 * Variance of the horizontal + vertical first differences over a raw single-channel buffer (higher =
 * sharper). Pooled into one population so a one-axis blur (camera pan) still scores low.
 */
export function gradientVariance(frame) {
  if (!isFrame(frame)) return 0;
  const { width, height, data } = frame;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (x + 1 < width) {
        const dx = data[i + 1] - data[i];
        sum += dx; sumSq += dx * dx; n++;
      }
      if (y + 1 < height) {
        const dy = data[i + width] - data[i];
        sum += dy; sumSq += dy * dy; n++;
      }
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/** Mean luma of a raw single-channel buffer, normalized to 0..1. */
export function meanLuma(frame) {
  if (!isFrame(frame)) return 0;
  const { width, height, data } = frame;
  const count = width * height;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += data[i];
  return sum / count / 255;
}

/**
 * Score one decoded frame. `recency` is 0 for the oldest candidate and 1 for the newest (a single
 * candidate counts as newest). Returns every component so callers can log WHY a tail was rejected.
 */
export function scoreFrame(frame, { recency = 1 } = {}) {
  const variance = gradientVariance(frame);
  const focus = clamp01(Math.log1p(variance) / Math.log1p(FOCUS_SCALE));
  const luma = meanLuma(frame);
  // Distance from mid-grey, normalized so pure black and pure white both hit 1.
  const exposurePenalty = clamp01(Math.abs(luma - 0.5) / 0.5);
  const r = clamp01(Number.isFinite(recency) ? recency : 0);
  const quality = focus - EXPOSURE_WEIGHT * exposurePenalty;
  return {
    variance,
    focus,
    luma,
    exposurePenalty,
    recency: r,
    quality,
    score: quality + RECENCY_WEIGHT * r,
    usable: variance >= MIN_SIGNAL_VARIANCE,
  };
}

/**
 * Decode an image file to a raw greyscale frame; null on ANY decode failure (a partial candidate
 * must never abort a render the user already paid GPU time for).
 */
export async function decodeGreyscaleFrame(path, { sharpImpl } = {}) {
  // `removeAlpha()` states the one-channel requirement explicitly; the channel check below is the
  // backstop, since an interleaved buffer is still >= width*height bytes and would pass the shape
  // check while the scorer read alpha samples as neighbouring pixels.
  if (sharpImpl === undefined) sharpImpl = (await import('sharp')).default;
  const decoded = await sharpImpl(path).removeAlpha().greyscale().raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  if (!decoded?.info) return null;
  const { width, height, channels } = decoded.info;
  // Interleaved data must never reach the scorer. `channels == null` (decoder didn't report) is not
  // evidence of a problem, so not `!channels`.
  if (channels != null && channels !== 1) return null;
  const frame = { width, height, data: decoded.data };
  return isFrame(frame) ? frame : null;
}

/**
 * Score every candidate path (timeline order, oldest first) and return the best, or null when
 * nothing decoded or all are degenerate. `index` is the position in the input array AS PASSED
 * (non-string entries are skipped, not renumbered): the caller derives the anchor's time offset from it.
 */
export async function pickBestFrame(paths, { sharpImpl } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length) return null;
  let best = null;
  // Decoded sequentially on purpose: only the score outlives each frame, so one raw buffer is live
  // at a time rather than width x height bytes per candidate.
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== 'string' || !list[i]) continue;
    const frame = await decodeGreyscaleFrame(list[i], { sharpImpl });
    if (!frame) continue;
    const recency = list.length === 1 ? 1 : i / (list.length - 1);
    const scored = scoreFrame(frame, { recency });
    if (!scored.usable) continue;
    if (!best || scored.score > best.score) best = { path: list[i], index: i, ...scored };
  }
  return best;
}
