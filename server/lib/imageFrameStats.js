/**
 * Degenerate-frame classifier (issue #4173).
 *
 * PortOS validates that a generated image *decodes*, never that it has
 * *content*. A decodable but degenerate frame — a solid-black render from a
 * local run that produced nothing, a fully-transparent sheet from a failed
 * sprite pass, a flat fill from a cloud CLI that declined and still emitted a
 * canvas — currently reaches the gallery, the sidecar, an entry's `imageRefs[]`
 * and (worst) a paid vision judge asked to describe a black square.
 *
 * `describeFrameStats` is the cheap numeric tell for that case: one `sharp`
 * `.stats()` decode gives per-channel mean/stdev plus the greyscale entropy,
 * and a frame whose every channel has stdev ≈ 0 is a solid fill that cannot be
 * a real render.
 *
 * TWO PROPERTIES THIS MODULE MUST KEEP:
 *
 * 1. **It is not a quality judge.** Only the mathematically degenerate case is
 *    rejected. A legitimately dark, low-key or minimalist render still carries
 *    real per-channel variance and MUST be accepted — the thresholds below sit
 *    far under anything an encoder can represent as signal precisely so that a
 *    real frame can never trip them.
 *
 * 2. **Sentinel correctness** (root CLAUDE.md): "could not compute stats" must
 *    NOT collapse into "degenerate". `ok` is three-valued —
 *      `true`  = measured, has content
 *      `false` = measured, degenerate (`reason` names which)
 *      `null`  = NOT measured (undecodable buffer, or too few pixels to judge)
 *    A `null` is logged and must never be treated as a generation failure; an
 *    undecodable buffer stays the caller's existing `INVALID_IMAGE` path.
 *    Callers therefore gate on `ok === false`, never on `!ok`.
 */

import sharp from 'sharp';

// Per-channel stdev, in 8-bit levels, under which a channel counts as flat.
// A genuinely flat fill reports exactly 0. Half of one 0-255 level is below
// the smallest difference an 8-bit encoder can even represent, so no real
// render — however dark — can land beneath it, while PNG/JPEG quantization
// noise in a real frame sits orders of magnitude above it.
export const SOLID_FILL_STDEV_EPSILON = 0.5;

// Shannon entropy (bits/pixel over the greyscale histogram, 0-8) under which a
// frame counts as empty. 0.05 bits ≈ fewer than ~0.5% of pixels differing from
// a single value — the indexed/palette analogue of a flat fill, which the
// stdev test can miss when a paletted encoder rounds a two-bucket histogram.
// A real render, even a near-black one, scores whole bits above this.
export const NEAR_EMPTY_ENTROPY_FLOOR = 0.05;

// Below this pixel count the statistics carry no information: a legitimate
// 8x8 icon or a 2x2 test tile really can be one flat color, so anything under
// 16x16 is reported as unjudgeable (`ok: null`) rather than degenerate.
export const MIN_JUDGEABLE_PIXELS = 256;

export const FRAME_REASON = {
  SOLID_FILL: 'solid-fill',
  FULLY_TRANSPARENT: 'fully-transparent',
  NEAR_EMPTY: 'near-empty',
  STATS_UNAVAILABLE: 'stats-unavailable',
  TOO_SMALL: 'too-small-to-judge',
};

// The reasons that mean "the backend produced no content". `stats-unavailable`
// and `too-small-to-judge` are deliberately NOT in here — they ride `ok: null`.
export const DEGENERATE_FRAME_REASONS = [
  FRAME_REASON.SOLID_FILL,
  FRAME_REASON.FULLY_TRANSPARENT,
  FRAME_REASON.NEAR_EMPTY,
];

const result = (ok, reason, perChannel = null) => ({ ok, reason, perChannel });

/**
 * Classify a decoded image as having content or being degenerate.
 *
 * @param {Buffer|string} input  encoded image bytes (or a path sharp can open)
 * @returns {Promise<{ ok: boolean|null, reason: string|null, perChannel: Array<{ mean: number, stdev: number, min: number, max: number }>|null }>}
 */
export async function describeFrameStats(input) {
  // One sharp instance per read — `metadata()` and `stats()` both consume the
  // pipeline, so sharing an instance between them is not safe.
  // Most callers run outside the Express request lifecycle (child-process
  // completion handlers), and a decode failure is explicitly NOT a verdict —
  // so the failure is captured, logged, and reported as the `null` sentinel.
  // `sharp()` itself throws synchronously for an empty/absent buffer, so the
  // whole probe runs inside a promise chain that converts that into the same
  // rejection an undecodable buffer produces.
  const probe = await Promise.resolve()
    .then(async () => ({ metadata: await sharp(input).metadata(), stats: await sharp(input).stats() }))
    .catch((err) => ({ err }));
  if (probe.err) {
    console.warn(`⚠️ Frame stats unavailable, skipping degenerate-frame check: ${probe.err?.message || probe.err}`);
    return result(null, FRAME_REASON.STATS_UNAVAILABLE);
  }

  const { metadata, stats } = probe;
  const channels = Array.isArray(stats.channels) ? stats.channels : [];
  if (!channels.length) {
    console.warn('⚠️ Frame stats returned no channels, skipping degenerate-frame check');
    return result(null, FRAME_REASON.STATS_UNAVAILABLE);
  }

  const pixels = Number(metadata.width) * Number(metadata.height);
  if (!Number.isFinite(pixels) || pixels < MIN_JUDGEABLE_PIXELS) {
    return result(null, FRAME_REASON.TOO_SMALL);
  }

  const perChannel = channels.map(({ mean, stdev, min, max }) => ({ mean, stdev, min, max }));

  // Alpha first: a fully-transparent sheet can carry arbitrary garbage in its
  // colour channels, so the colour tests below would not see it.
  if (metadata.hasAlpha) {
    const alpha = perChannel[perChannel.length - 1];
    if (alpha.max === 0) return result(false, FRAME_REASON.FULLY_TRANSPARENT, perChannel);
  }

  // Only the colour channels decide "flat" — a fully-OPAQUE alpha channel is
  // itself flat by definition and would otherwise veto every normal PNG.
  const colour = metadata.hasAlpha ? perChannel.slice(0, -1) : perChannel;
  if (colour.length && colour.every((c) => c.stdev < SOLID_FILL_STDEV_EPSILON)) {
    return result(false, FRAME_REASON.SOLID_FILL, perChannel);
  }

  // sharp reports entropy only when it could compute one; a missing value is
  // not evidence of emptiness, so it falls through to `ok: true`.
  if (typeof stats.entropy === 'number' && stats.entropy < NEAR_EMPTY_ENTROPY_FLOOR) {
    return result(false, FRAME_REASON.NEAR_EMPTY, perChannel);
  }

  return result(true, null, perChannel);
}

/** True only for a measured, degenerate verdict — never for the `null` sentinel. */
export const isDegenerateFrame = (stats) => stats?.ok === false;
