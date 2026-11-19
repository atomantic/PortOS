/**
 * Degenerate-frame classifier (issue #4173).
 *
 * PortOS validates that a generated image *decodes*, never that it has *content*; a solid-black,
 * fully-transparent or flat-fill frame would reach the gallery and a paid vision judge.
 * `describeFrameStats` is the cheap numeric tell: one `sharp` `.stats()` decode gives per-channel
 * mean/stdev plus greyscale entropy, and stdev ≈ 0 on every channel is a solid fill.
 *
 * TWO PROPERTIES THIS MODULE MUST KEEP:
 *
 * 1. **It is not a quality judge.** Only the mathematically degenerate case is rejected; the
 *    thresholds sit far under anything an encoder can represent as signal, so a legitimately dark
 *    or minimalist render can never trip them.
 *
 * 2. **Sentinel correctness** (root AGENTS.md): "could not compute stats" must NOT collapse into
 *    "degenerate". `ok` is `true` (measured, has content), `false` (measured, degenerate;
 *    `reason` names which) or `null` (NOT measured: undecodable buffer or too few pixels). A
 *    `null` is logged, never a generation failure; callers gate on `ok === false`, never `!ok`.
 */

import sharp from 'sharp';
import { createHash } from 'crypto';
import { createBoundedStateMap } from './boundedStateMap.js';

// Per-channel stdev (8-bit levels) under which a channel counts as flat. Half a level is below what an
// 8-bit encoder can represent, so no real render lands beneath it; quantization noise sits far above.
export const SOLID_FILL_STDEV_EPSILON = 0.5;

// Greyscale entropy (bits/pixel, 0-8) under which a frame counts as empty (~0.5% of pixels differing):
// the palette analogue of a flat fill, which the stdev test can miss. Real renders score whole bits above.
export const NEAR_EMPTY_ENTROPY_FLOOR = 0.05;

// Under 16x16 a legitimate icon or test tile can really be one flat color: unjudgeable (`ok: null`).
export const MIN_JUDGEABLE_PIXELS = 256;

// ~0.5% signal floor for alpha-only silhouettes; both visible and transparent coverage must clear
// it. Unitless because Sharp reports 16-bit PNG channel stats on a 0-65535 scale.
export const ALPHA_COVERAGE_FRACTION_FLOOR = 0.005;

// Binary-mask stdev for a 5% minority: keeps alpha speckle from rescuing a flat colour fill.
export const ALPHA_SILHOUETTE_STDEV_FRACTION_FLOOR = Math.sqrt(0.05 * 0.95);

export const FRAME_REASON = {
  SOLID_FILL: 'solid-fill',
  FULLY_TRANSPARENT: 'fully-transparent',
  NEAR_EMPTY: 'near-empty',
  STATS_UNAVAILABLE: 'stats-unavailable',
  TOO_SMALL: 'too-small-to-judge',
};

const result = (ok, reason, perChannel = null) => ({ ok, reason, perChannel });

/**
 * Content-addressed verdict memo (issue #6004). The verdict is a pure function of the bytes and
 * `sharp().stats()` costs ~4 ms even for a 40x40 frame (libvips setup), while sprite compiles
 * re-probe the SAME bytes constantly; keyed on the sha256 of the buffer.
 *
 * Buffers ONLY: a path is not content, since the file behind it can change between calls.
 *
 * `stats-unavailable` is NOT memoized: that branch catches every probe failure, including transient
 * libvips ones on a valid frame, which would otherwise pin `ok: null` for the whole TTL and silently
 * disable the gate. `too-small-to-judge` IS memoized (read off a successful decode).
 */
const verdictCache = createBoundedStateMap({ maxSize: 2000, ttlMs: 60 * 60 * 1000 });

// Copy so a cached entry can't become shared mutable state.
const copyVerdict = ({ ok, reason, perChannel }) => ({
  ok,
  reason,
  perChannel: perChannel ? perChannel.map((channel) => ({ ...channel })) : null,
});

/** Test seam: drop every memoized verdict. */
export const __resetFrameStatsCache = () => verdictCache.clear();

/**
 * Classify a decoded image as having content or being degenerate.
 *
 * @param {Buffer|string} input  encoded image bytes (or a path sharp can open)
 * @returns {Promise<{ ok: boolean|null, reason: string|null, perChannel: Array<{ mean: number, stdev: number, min: number, max: number }>|null }>}
 */
export async function describeFrameStats(input) {
  const cacheKey = Buffer.isBuffer(input)
    ? createHash('sha256').update(input).digest('hex')
    : null;
  if (cacheKey) {
    const memo = verdictCache.get(cacheKey);
    if (memo) return copyVerdict(memo);
  }
  const verdict = await measureFrameStats(input);
  if (cacheKey && verdict.reason !== FRAME_REASON.STATS_UNAVAILABLE) {
    verdictCache.set(cacheKey, verdict);
  }
  return copyVerdict(verdict);
}

async function measureFrameStats(input) {
  // One sharp instance per read: `metadata()` and `stats()` both consume the pipeline. A decode
  // failure is NOT a verdict, so it is logged and reported as the `null` sentinel; `sharp()` throws
  // synchronously for an empty buffer, hence the promise chain.
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

  // Alpha first: a fully-transparent sheet can carry garbage in its colour channels.
  if (metadata.hasAlpha) {
    const alpha = perChannel[perChannel.length - 1];
    if (alpha.max === 0) return result(false, FRAME_REASON.FULLY_TRANSPARENT, perChannel);
  }

  // A transparent sprite can carry its whole silhouette in alpha with single-colour RGB; that variance
  // is content, unlike a fully opaque alpha channel, which must not rescue a flat fill.
  const alpha = metadata.hasAlpha ? perChannel[perChannel.length - 1] : null;
  const alphaMax = metadata.depth === 'ushort' ? 65535 : 255;
  const alphaMeanFraction = alpha ? alpha.mean / alphaMax : 0;
  const alphaStdevFraction = alpha ? alpha.stdev / alphaMax : 0;
  const alphaCarriesContent = Boolean(
    alpha
      && !stats.isOpaque
      && alpha.max > alpha.min
      && alphaStdevFraction >= ALPHA_SILHOUETTE_STDEV_FRACTION_FLOOR
      && alphaMeanFraction >= ALPHA_COVERAGE_FRACTION_FLOOR
      && alphaMeanFraction <= 1 - ALPHA_COVERAGE_FRACTION_FLOOR,
  );

  // Only colour channels decide "flat": a fully-opaque alpha is itself flat and would veto every PNG.
  const colour = metadata.hasAlpha ? perChannel.slice(0, -1) : perChannel;
  if (!alphaCarriesContent && colour.length && colour.every((c) => c.stdev < SOLID_FILL_STDEV_EPSILON)) {
    return result(false, FRAME_REASON.SOLID_FILL, perChannel);
  }

  // A missing entropy is not evidence of emptiness, so it falls through to `ok: true`.
  if (!alphaCarriesContent && typeof stats.entropy === 'number' && stats.entropy < NEAR_EMPTY_ENTROPY_FLOOR) {
    return result(false, FRAME_REASON.NEAR_EMPTY, perChannel);
  }

  return result(true, null, perChannel);
}

/** True only for a measured, degenerate verdict — never for the `null` sentinel. */
export const isDegenerateFrame = (stats) => stats?.ok === false;
