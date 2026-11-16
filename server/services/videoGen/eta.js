/**
 * Video Gen — history-calibrated render ETA.
 *
 * Local video renders run 15–40+ minutes and the child emits no wall-clock estimate.
 * This module estimates from the install's own measured runs: no hand-tuned constants.
 *
 * The model, in order of preference:
 *
 *   1. **Measured** — records of the *same shape* (same model + width × height ×
 *      numFrames × steps) exist; the median of those durations wins outright.
 *   2. **Linear fit** — same model, differing shapes. Cost is close to
 *      `a · (pixels × frames × steps) + b`, where `b` is the fixed per-render cost
 *      (weight load, text encode, VAE decode, mux). Least-squares over recent
 *      same-model records recovers both; `b` is what makes chained renders estimable
 *      (an N-chunk chain pays it N times).
 *   3. **Proportional** — samples too few/degenerate to separate the fixed cost: median
 *      ms-per-work-unit with no intercept.
 *   4. **No estimate** — nothing usable. Returns `null`, never a fabricated number and
 *      never `0` (a fresh install has no measurements by definition).
 *
 * Everything here is pure: `history` is passed in, never read from disk.
 *
 * Deliberately NOT in the shape key: mode (t2v / i2v / fflf / extend) and LoRAs. Folding
 * them in would fragment the small sample set into buckets too thin to fit, and the
 * variance they add is ordinary estimate noise.
 */

// Only the most recent N same-model records feed a fit; older runs drift from present
// reality (runtime build, thermal envelope, competing load).
const RECENT_SAMPLE_LIMIT = 20;
// Exact-shape matches are the strongest signal, so a short window suffices and keeps the
// median responsive to a runtime upgrade that halved render time.
const EXACT_SAMPLE_LIMIT = 5;
// A linear fit needs enough spread to separate slope from intercept. Below
// this it overfits noise and can produce an absurd (even negative) intercept.
const MIN_FIT_SAMPLES = 3;
// Divisor applied to work units before the least-squares sums so `x²` stays inside the
// exactly-representable integer range. Cancels out of the returned slope.
const WORK_FIT_SCALE = 1e6;

/**
 * Sampler work for one render, in arbitrary but consistent units.
 * Returns null when any dimension is missing or non-positive — an entry we
 * can't place on the cost curve must be dropped, not defaulted to zero.
 */
export const renderWorkUnits = ({ width, height, numFrames, steps }) => {
  const dims = [width, height, numFrames, steps].map(Number);
  if (dims.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return dims.reduce((a, b) => a * b, 1);
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const entryTime = (entry) => {
  const t = Date.parse(entry?.createdAt ?? '');
  return Number.isFinite(t) ? t : 0;
};

/**
 * Normalize a record's / request's speed profile to a single comparable key. Absence and
 * the default profile are the same bucket (lib/videoSpeedProfiles.js). Kept local so
 * this module stays free of registry dependencies.
 */
const DEFAULT_SPEED_BUCKET = 'quality';
const speedBucket = (id) => (id == null || id === '' ? DEFAULT_SPEED_BUCKET : String(id));

/**
 * Timed, shape-complete history records for one model AND one speed profile, newest
 * first. `renderMs` is stamped by finalizeGeneratedVideo; entries without it (and
 * non-render entries like downloaded videos) are excluded rather than guessed at.
 *
 * The speed profile is part of the sample key, unlike mode and LoRAs: a profile swaps
 * the whole schedule (CFG 1.0 drops the negative branch, stage 2 runs fewer steps,
 * TeaCache skips residuals), so it moves the cost curve's SLOPE rather than adding
 * variance. Pooling would over-estimate every fast render and under-estimate every
 * quality one, a confidently wrong number this module treats as worse than none. The
 * first renders on a newly-picked profile therefore have no estimate.
 *
 * A render whose profile partly degraded still lands in its requested bucket;
 * degradation is rare and ordinary variance next to the slope difference.
 */

/**
 * A timed row whose `renderMs` does NOT measure "this model rendering these work units
 * on this machine" and so must never train the cost model, even though it carries a
 * `modelId` and a positive `renderMs`. Each is a derived record that inherits its
 * source's model and dials while measuring something else:
 *
 *  - `upscaledFrom` — keeps the source's `steps`/`numFrames` but DOUBLES width and
 *    height (4× work units), while its duration is an ffmpeg 2× pass. The worst sample
 *    a least-squares fit could be handed.
 *  - `federatedPeerId` — rendered on a PEER's hardware; the span includes submission,
 *    the peer's queue wait, download and verification.
 *  - `chainedFrom` / `stitchedFrom` — chunk rows are themselves timed samples, so the
 *    stitched total would double-count them.
 *
 * Keyed on discriminators the rows already carry rather than a tag writers must remember
 * to set, so a future derived-record path is excluded once it stamps one of these.
 */
const DERIVED_RECORD_KEYS = ['upscaledFrom', 'federatedPeerId', 'chainedFrom', 'stitchedFrom'];
const isDerivedRecord = (e) => DERIVED_RECORD_KEYS.some((key) => e[key] != null);

export const timedRenderSamples = (history, modelId, speedProfileId = null) => {
  if (!Array.isArray(history)) return [];
  const wantBucket = speedBucket(speedProfileId);
  return history
    .filter((e) => e && e.modelId === modelId && speedBucket(e.speedProfileId) === wantBucket
      && !isDerivedRecord(e)
      && Number.isFinite(Number(e.renderMs)) && Number(e.renderMs) > 0)
    .map((e) => ({
      workUnits: renderWorkUnits(e),
      durationMs: Number(e.renderMs),
      width: Number(e.width),
      height: Number(e.height),
      numFrames: Number(e.numFrames),
      steps: Number(e.steps),
      at: entryTime(e),
    }))
    .filter((s) => s.workUnits != null)
    .sort((a, b) => b.at - a.at);
};

/**
 * Least-squares `ms = perUnitMs · work + fixedMs` over the samples. Returns null when the
 * samples can't support a fit (too few, all one shape, or a non-positive slope, which
 * means noise). A negative intercept is clamped to 0 rather than discarded, since a
 * negative fixed cost would make short renders estimate below zero.
 */
export const fitRenderCost = (samples) => {
  if (!Array.isArray(samples) || samples.length < MIN_FIT_SAMPLES) return null;
  const n = samples.length;
  // Work units are ~1e9, so `x²` (~1e18) exceeds the 2^53 exact-integer range of a double
  // and `n·Σx² − (Σx)²` suffers catastrophic cancellation when samples are close
  // together (the common case). Fitting in scaled units keeps intermediates exact; the
  // slope is rescaled on the way out.
  const xs = samples.map((s) => s.workUnits / WORK_FIT_SCALE);
  const sumX = xs.reduce((a, x) => a + x, 0);
  const sumY = samples.reduce((a, s) => a + s.durationMs, 0);
  const sumXY = samples.reduce((a, s, i) => a + xs[i] * s.durationMs, 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  // A vanishing denominator means every sample has (nearly) the same work units: no
  // recoverable slope. Compared against a relative epsilon, not 0, because identical
  // inputs still leave float dust that would yield an astronomical slope (an ETA of years).
  if (!(denom > n * sumXX * 1e-12)) return null;
  const perUnitMs = ((n * sumXY - sumX * sumY) / denom) / WORK_FIT_SCALE;
  if (!Number.isFinite(perUnitMs) || perUnitMs <= 0) return null;
  const fixedMs = (sumY - perUnitMs * WORK_FIT_SCALE * sumX) / n;
  if (!Number.isFinite(fixedMs)) return null;
  return { perUnitMs, fixedMs: Math.max(0, fixedMs) };
};

/**
 * Estimate wall-clock render time for a job about to start.
 *
 * @param {object} ctx
 * @param {Array} ctx.history - the video render history (newest-first list)
 * @param {string} ctx.modelId
 * @param {number} ctx.width
 * @param {number} ctx.height
 * @param {number} ctx.numFrames - frames rendered PER CHUNK
 * @param {number} ctx.steps
 * @param {string|null} [ctx.speedProfileId=null] - the speed profile this render will use.
 *   Samples are scoped to the matching profile; see `timedRenderSamples`.
 * @param {number} [ctx.chunks=1] - chained-render chunk count. Each chunk pays the fixed
 *   per-render cost again, so the estimate is `chunks × per-chunk estimate`.
 * @returns {{ etaMs: number, perChunkMs: number, chunks: number, basis: 'measured'|'linear'|'proportional', sampleCount: number } | null}
 *   null when history holds no usable measurement for this model + profile.
 */
export const estimateRenderMs = ({ history, modelId, width, height, numFrames, steps, speedProfileId = null, chunks = 1 }) => {
  const workUnits = renderWorkUnits({ width, height, numFrames, steps });
  if (workUnits == null) return null;
  const chunkCount = Number.isFinite(Number(chunks)) && Number(chunks) > 0 ? Math.floor(Number(chunks)) : 1;
  const samples = timedRenderSamples(history, modelId, speedProfileId);
  if (!samples.length) return null;

  // Final backstop: a non-positive or non-finite estimate is not an estimate; every
  // consumer reads a number as truth.
  const finish = (perChunkMs, basis, sampleCount) => {
    if (!Number.isFinite(perChunkMs) || perChunkMs <= 0) return null;
    const etaMs = Math.round(perChunkMs * chunkCount);
    // Checked AFTER rounding: a sub-millisecond estimate is positive but
    // rounds to 0, and 0 is the one number this must never report.
    if (etaMs <= 0) return null;
    return {
      etaMs,
      perChunkMs: Math.round(perChunkMs),
      chunks: chunkCount,
      basis,
      sampleCount,
    };
  };

  // 1. A real measurement of this exact shape overrides the model.
  const exact = samples
    .filter((s) => s.width === Number(width) && s.height === Number(height)
      && s.numFrames === Number(numFrames) && s.steps === Number(steps))
    .slice(0, EXACT_SAMPLE_LIMIT);
  if (exact.length) return finish(median(exact.map((s) => s.durationMs)), 'measured', exact.length);

  const recent = samples.slice(0, RECENT_SAMPLE_LIMIT);

  // 2. Linear fit — recovers the per-chunk fixed cost along with the slope.
  const fit = fitRenderCost(recent);
  const fitted = fit ? finish(fit.perUnitMs * workUnits + fit.fixedMs, 'linear', recent.length) : null;
  if (fitted) return fitted;

  // 3. Proportional — median rate, no separable fixed cost.
  const rate = median(recent.map((s) => s.durationMs / s.workUnits));
  return finish(rate * workUnits, 'proportional', recent.length);
};
