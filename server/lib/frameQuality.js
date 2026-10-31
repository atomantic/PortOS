/**
 * Frame-quality scoring — picks the video continuation anchor by measuring
 * candidate frames instead of trusting wherever an end-seek happens to land.
 *
 * A chained render conditions chunk N+1 on ONE frame taken from the tail of
 * chunk N. Local video output is motion-heavy by construction (the prompt
 * guidance explicitly asks for a camera move and a visible action), so that
 * frame is frequently motion-blurred, mid-blink, or inside a fade — and the
 * next chunk inherits the blur as the scene's actual content, compounding
 * through every subsequent hop.
 *
 * The scoring is deliberately cheap and dependency-free beyond `sharp` (already
 * a server dependency): decode each candidate to a raw single-channel buffer,
 * then combine three terms.
 *
 *   focus     — log-compressed variance of the first-difference gradient.
 *               Log compression is what keeps one exceptionally sharp frame
 *               from swamping the exposure term.
 *   exposure  — penalty on the distance of mean luma from mid-grey, which is
 *               what rejects a frame inside a fade-to-black or a blown highlight.
 *   recency   — a small linear preference for later frames, so among
 *               comparably clean candidates the anchor stays as close to the
 *               cut as possible. Without it the scorer drifts toward the calm
 *               middle of the window and continuity loosens.
 *
 * Usability is a SEPARATE question from ranking. `usable` gates on raw gradient
 * variance alone, so only a mathematically degenerate frame (a solid fill, a
 * fully faded one) is rejected outright and a dark-but-real low-key tail still
 * qualifies. Exposure shapes the RANKING, not the gate.
 */

import sharp from 'sharp';

// Tail window the candidates are decoded from, and how densely.
//
// The window is deliberately capped at the reach of the single `-sseof -1.0`
// seek this replaces. Focus tends to be HIGHEST at the oldest candidate (motion,
// and therefore blur, accumulates toward the cut), so a wider window would let
// the scorer routinely anchor further from the cut than the old behavior did —
// widening the backward jump at every chain seam instead of tightening it. The
// recency bonus biases toward the cut but cannot bound the window on its own.
export const TAIL_WINDOW_SECONDS = 1.0;
export const CANDIDATE_FPS = 12;
// Derived, never an independent number: the ffmpeg-side cap (`-frames:v`)
// truncates from the NEWEST end, which is exactly the frames the recency term
// prefers. If the two ever disagreed, the cap would silently discard the pick.
export const MAX_CANDIDATES = Math.round(TAIL_WINDOW_SECONDS * CANDIDATE_FPS);

// Gradient variance that maps to a focus of 1.0. Real sharp frames land in the
// low thousands, so this leaves headroom without clamping ordinary content.
export const FOCUS_SCALE = 20000;
export const EXPOSURE_WEIGHT = 0.6;
export const RECENCY_WEIGHT = 0.15;

// Gradient variance below which a frame carries no signal at all — a solid
// fill, a fully faded frame, or a decode that produced nothing.
//
// This, NOT the composite score, is what `usable` gates on. Gating on a
// score that includes the exposure penalty would reject a legitimately dark,
// low-key tail (mean luma 0.12 alone costs ~0.46 of quality) and silently
// revert every night scene to the unscored end seek. Same property
// `imageFrameStats.js` commits to: reject only the mathematically degenerate
// case, never dark-but-real content. Exposure still does its job in the
// RANKING, where a fade-to-black loses to its neighbours.
//
// 0.25 is (0.5 levels)^2 — half of one 8-bit level, below the smallest
// difference an encoder can represent, mirroring `SOLID_FILL_STDEV_EPSILON`.
export const MIN_SIGNAL_VARIANCE = 0.25;

const clamp01 = (n) => (n < 0 ? 0 : (n > 1 ? 1 : n));

const isFrame = (frame) => !!frame
  && Number.isInteger(frame.width) && Number.isInteger(frame.height)
  && frame.width > 0 && frame.height > 0
  && frame.data?.length >= frame.width * frame.height;

/**
 * Variance of the horizontal + vertical first differences over a raw
 * single-channel buffer. Higher = sharper. Both difference sets are pooled
 * into one sample population so a frame blurred along only one axis (the
 * common camera-pan case) still scores low.
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
 * Score one decoded frame. `recency` is 0 for the oldest candidate in the
 * window and 1 for the newest; a single candidate is treated as newest.
 *
 * Returns every component, not just the total, so a caller can log WHY a tail
 * was rejected instead of just that it was.
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
 * Decode an image file to a raw greyscale frame. Returns null on ANY decode
 * failure — a candidate ffmpeg wrote partially (or not at all) is simply not a
 * candidate, and must never abort a render the user already paid GPU time for.
 */
export async function decodeGreyscaleFrame(path, { sharpImpl = sharp } = {}) {
  // On sharp 0.35.3 `.greyscale().raw()` already lands ONE channel even for an
  // RGBA source (verified: byte-identical with and without removeAlpha). The
  // explicit `removeAlpha()` makes that a stated requirement rather than an
  // incidental property, and the channel check below is the backstop if it ever
  // stops holding: an interleaved buffer is still ≥ width×height bytes, so the
  // shape check alone would pass while gradientVariance read alpha samples as
  // neighbouring pixels and meanLuma averaged half the image.
  const decoded = await sharpImpl(path).removeAlpha().greyscale().raw()
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);
  if (!decoded?.info) return null;
  const { width, height, channels } = decoded.info;
  // Interleaved data must never reach the scorer; a null simply drops this
  // candidate. `channels == null` means the decoder didn't report it, which is
  // not evidence of a problem — sentinel discipline, not `!channels`.
  if (channels != null && channels !== 1) return null;
  const frame = { width, height, data: decoded.data };
  return isFrame(frame) ? frame : null;
}

/**
 * Score every candidate path (given in timeline order, oldest first) and
 * return the best one, or null when nothing decoded or every candidate is
 * degenerate. The returned `index` is the candidate's position in the input
 * array AS PASSED — non-string entries are skipped, not renumbered — because
 * the caller derives the anchor's time offset from it.
 */
export async function pickBestFrame(paths, { sharpImpl = sharp } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  if (!list.length) return null;
  let best = null;
  // Indices are positions in the CALLER's array, never in a filtered copy —
  // the caller derives the anchor's time offset from `index` against that same
  // array, so a renumbering here would silently mis-report the offset. Skipped
  // entries are holes in the timeline, not a reason to shift the rest.
  //
  // Decoded sequentially on purpose: only the SCORE outlives each frame, so
  // one raw buffer is live at a time. Decoding the whole window at once would
  // hold width × height bytes per candidate simultaneously, which scales with
  // the render resolution for no wall-clock that matters next to a GPU render.
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
