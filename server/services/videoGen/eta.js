/**
 * Video Gen — history-calibrated render ETA.
 *
 * Local video renders run 15–40+ minutes. The child emits step progress but no
 * wall-clock estimate, so the UI can only say "step 7/30" for half an hour.
 * This module turns the render history into an estimate using nothing but the
 * install's own measured runs — no hand-tuned constants, no per-chip table.
 *
 * The model, in order of preference:
 *
 *   1. **Measured** — records of the *same shape* (same model + width × height ×
 *      numFrames × steps) already exist. A real measurement always beats a
 *      model, so the median of those durations is the answer outright.
 *   2. **Linear fit** — same model, differing shapes. Render cost is very close
 *      to `a · (pixels × frames × steps) + b`: the sampler work scales with the
 *      product, while `b` is the fixed cost paid once per render (weight load,
 *      text encode, VAE decode, mux). Least-squares over the recent same-model
 *      records recovers both. `b` is what makes chained renders estimable —
 *      an N-chunk chain pays it N times, not once.
 *   3. **Proportional** — too few / too degenerate a sample set to separate the
 *      fixed cost, so fall back to the median ms-per-work-unit with no
 *      intercept.
 *   4. **No estimate** — nothing usable in history. Returns `null`, an explicit
 *      absent sentinel. Never a fabricated number and never `0`: a caller that
 *      showed "0s remaining" for an unmeasured model would be lying, and a
 *      fresh install has no measurements by definition.
 *
 * Everything here is pure — `history` is passed in, never read from disk.
 *
 * Deliberately NOT in the shape key: mode (t2v / i2v / fflf / extend) and
 * LoRAs. They do move render cost, but folding them in would fragment an
 * install's already-small sample set into buckets too thin to fit — and the
 * resulting variance is ordinary estimate noise, whereas an over-narrow key
 * produces "no estimate" for renders we could have called within a minute.
 */

// Only the most recent N same-model records feed a fit. Older runs drift away
// from present reality (different runtime build, different thermal envelope,
// different competing load), and an unbounded window would let a year-old
// sample outvote last week's.
const RECENT_SAMPLE_LIMIT = 20;
// Exact-shape matches are the strongest signal, so a much shorter window is
// enough — and staying short keeps the median responsive to a runtime upgrade
// that halved render time.
const EXACT_SAMPLE_LIMIT = 5;
// A linear fit needs enough spread to separate slope from intercept. Below
// this it overfits noise and can produce an absurd (even negative) intercept.
const MIN_FIT_SAMPLES = 3;
// Divisor applied to work units before the least-squares sums, so `x²` stays
// far inside the exactly-representable integer range. Purely numerical — it
// cancels out of the returned slope.
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
 * Timed, shape-complete history records for one model, newest first.
 * `renderMs` is stamped by finalizeGeneratedVideo; entries that predate it
 * (and non-render entries like downloaded videos) simply have no measurement
 * and are excluded rather than guessed at.
 */
export const timedRenderSamples = (history, modelId) => {
  if (!Array.isArray(history)) return [];
  return history
    .filter((e) => e && e.modelId === modelId && Number.isFinite(Number(e.renderMs)) && Number(e.renderMs) > 0)
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
 * Least-squares `ms = perUnitMs · work + fixedMs` over the samples.
 * Returns null when the samples can't support a fit (too few, all one shape,
 * or a fit whose slope came out non-positive — which means the sample set is
 * noise, not a cost curve). A negative intercept is clamped to 0 rather than
 * discarded: the slope is still informative, and a negative fixed cost would
 * make short renders estimate below zero.
 */
export const fitRenderCost = (samples) => {
  if (!Array.isArray(samples) || samples.length < MIN_FIT_SAMPLES) return null;
  const n = samples.length;
  // Work units are ~1e9 for a real render, so `x²` would land near 1e18 —
  // past the 2^53 integer-exact range of a double. `n·Σx² − (Σx)²` then
  // subtracts two ~1e20 values whose low bits are already gone, which is
  // catastrophic cancellation exactly when the samples are close together
  // (the common case: a few renders at neighboring frame counts). Fitting in
  // scaled units keeps every intermediate comfortably exact; the slope is
  // rescaled back on the way out so the returned units are unchanged.
  const xs = samples.map((s) => s.workUnits / WORK_FIT_SCALE);
  const sumX = xs.reduce((a, x) => a + x, 0);
  const sumY = samples.reduce((a, s) => a + s.durationMs, 0);
  const sumXY = samples.reduce((a, s, i) => a + xs[i] * s.durationMs, 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  // A vanishing denominator = every sample has (near enough) the same work
  // units, so the fit is a vertical line with no recoverable slope. Compared
  // against a relative epsilon rather than exactly 0: identical inputs still
  // leave float dust in `n·Σx² − (Σx)²`, and dividing by 1e-9 of dust yields
  // an astronomical slope that would be reported as a confident ETA of years.
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
 * @param {number} [ctx.chunks=1] - chained-render chunk count. Each chunk is a
 *   full render of its own and pays the fixed per-render cost again, so the
 *   chain estimate is `chunks × per-chunk estimate` — not a single render
 *   scaled by total frames.
 * @returns {{ etaMs: number, perChunkMs: number, chunks: number, basis: 'measured'|'linear'|'proportional', sampleCount: number } | null}
 *   null when history holds no usable measurement for this model.
 */
export const estimateRenderMs = ({ history, modelId, width, height, numFrames, steps, chunks = 1 }) => {
  const workUnits = renderWorkUnits({ width, height, numFrames, steps });
  if (workUnits == null) return null;
  const chunkCount = Number.isFinite(Number(chunks)) && Number(chunks) > 0 ? Math.floor(Number(chunks)) : 1;
  const samples = timedRenderSamples(history, modelId);
  if (!samples.length) return null;

  // Final backstop: an estimate that isn't a positive finite number is not an
  // estimate. Returning 0 (or NaN, or a negative) here would be worse than
  // returning nothing, because every consumer reads a number as truth.
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
