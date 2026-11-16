/**
 * Video Gen — history-calibrated render ETA.
 *
 * Local video renders run 15–40+ minutes and the child emits no estimate, so
 * this estimates from the install's own measured runs (no hand-tuned constants),
 * in order of preference:
 *
 *   1. **Measured** — records of the same shape (model + width × height ×
 *      numFrames × steps): their median wins outright.
 *   2. **Linear fit** — same model, differing shapes: least-squares
 *      `a · (pixels × frames × steps) + b` over recent records. `b` is the fixed
 *      per-render cost, which makes chained renders estimable (N chunks pay it N times).
 *   3. **Proportional** — too few/degenerate samples to separate the fixed cost:
 *      median ms-per-work-unit with no intercept.
 *   4. **No estimate** — returns `null`, never a fabricated number and never `0`.
 *
 * Pure: `history` is passed in, never read from disk. Mode (t2v / i2v / fflf /
 * extend) and LoRAs are deliberately NOT in the shape key; folding them in would
 * fragment the sample set into buckets too thin to fit.
 */

// Only the most recent N same-model records feed a fit; older runs drift.
const RECENT_SAMPLE_LIMIT = 20;
// Exact-shape matches are the strongest signal; a short window stays responsive.
const EXACT_SAMPLE_LIMIT = 5;
// A linear fit needs spread to separate slope from intercept; below this it overfits noise.
const MIN_FIT_SAMPLES = 3;
// Work units are divided by this before the least-squares sums; cancels out of the slope.
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
 * Timed, shape-complete history records for one model AND one speed profile,
 * newest first. Entries without `renderMs` (stamped by finalizeGeneratedVideo)
 * are excluded rather than guessed at.
 *
 * Unlike mode and LoRAs, the speed profile is part of the sample key: it swaps
 * the whole schedule, so it moves the cost curve's SLOPE. Pooling would give a
 * confidently wrong number, which this module treats as worse than none, so the
 * first renders on a newly-picked profile have no estimate. A render whose
 * profile partly degraded still lands in its requested bucket.
 */

/**
 * A timed row whose `renderMs` does NOT measure "this model rendering these work
 * units on this machine" and must never train the cost model. Each is a derived
 * record inheriting its source's model and dials:
 *
 *  - `upscaledFrom` — keeps `steps`/`numFrames` but doubles width and height
 *    while its duration is an ffmpeg 2× pass.
 *  - `federatedPeerId` — rendered on a peer's hardware; includes queue wait,
 *    download and verification.
 *  - `chainedFrom` / `stitchedFrom` — chunk rows are already samples; the
 *    stitched total would double-count them.
 *
 * Keyed on discriminators rows already carry, so a future derived-record path
 * is excluded once it stamps one of these.
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
 * Least-squares `ms = perUnitMs · work + fixedMs` over the samples. Null when
 * they can't support a fit (too few, all one shape, non-positive slope). A
 * negative intercept is clamped to 0 so short renders never estimate below zero.
 */
export const fitRenderCost = (samples) => {
  if (!Array.isArray(samples) || samples.length < MIN_FIT_SAMPLES) return null;
  const n = samples.length;
  // Work units are ~1e9, so `x²` exceeds the 2^53 exact-integer range and
  // `n·Σx² − (Σx)²` cancels catastrophically. Fit in scaled units; the slope
  // is rescaled on the way out.
  const xs = samples.map((s) => s.workUnits / WORK_FIT_SCALE);
  const sumX = xs.reduce((a, x) => a + x, 0);
  const sumY = samples.reduce((a, s) => a + s.durationMs, 0);
  const sumXY = samples.reduce((a, s, i) => a + xs[i] * s.durationMs, 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  // A vanishing denominator means no recoverable slope. Compared against a
  // relative epsilon, not 0: float dust would otherwise yield an ETA of years.
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
 * @param {string|null} [ctx.speedProfileId=null] - samples are scoped to the matching profile
 * @param {number} [ctx.chunks=1] - each chunk pays the fixed per-render cost again
 * @returns {{ etaMs: number, perChunkMs: number, chunks: number, basis: 'measured'|'linear'|'proportional', sampleCount: number } | null}
 *   null when history holds no usable measurement for this model + profile.
 */
export const estimateRenderMs = ({ history, modelId, width, height, numFrames, steps, speedProfileId = null, chunks = 1 }) => {
  const workUnits = renderWorkUnits({ width, height, numFrames, steps });
  if (workUnits == null) return null;
  const chunkCount = Number.isFinite(Number(chunks)) && Number(chunks) > 0 ? Math.floor(Number(chunks)) : 1;
  const samples = timedRenderSamples(history, modelId, speedProfileId);
  if (!samples.length) return null;

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

  const exact = samples
    .filter((s) => s.width === Number(width) && s.height === Number(height)
      && s.numFrames === Number(numFrames) && s.steps === Number(steps))
    .slice(0, EXACT_SAMPLE_LIMIT);
  if (exact.length) return finish(median(exact.map((s) => s.durationMs)), 'measured', exact.length);

  const recent = samples.slice(0, RECENT_SAMPLE_LIMIT);

  const fit = fitRenderCost(recent);
  const fitted = fit ? finish(fit.perUnitMs * workUnits + fit.fixedMs, 'linear', recent.length) : null;
  if (fitted) return fitted;

  const rate = median(recent.map((s) => s.durationMs / s.workUnits));
  return finish(rate * workUnits, 'proportional', recent.length);
};
