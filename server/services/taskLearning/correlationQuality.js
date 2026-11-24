/**
 * Task Learning — correlation-quality measurement window (#2344, carved out of #2329).
 *
 * Over a rolling window, correlates each run's *prediction* (did the enriched
 * failure signal flag its tier as risky, from history BEFORE the run?) with its
 * *actual outcome*, yielding a score that says whether avoidance is worth acting
 * on aggressively. `suggestModelTier` (routing.js) gates on that score clearing
 * `CORRELATION_QUALITY_THRESHOLD`. Pure except the `getCorrelationQuality()` loader.
 */

// Rolling window bound, like `failureSignatures.recent`.
const MAX_CORRELATION_SAMPLES = 200;

// Below this many samples the phi coefficient is too noisy to gate on:
// `confident` stays false and routing treats the signal as unproven.
export const MIN_CORRELATION_SAMPLES = 20;

// Matthews/phi coefficient ([-1,1]) the signal must exceed before routing acts aggressively.
export const CORRELATION_QUALITY_THRESHOLD = 0.8;

/**
 * Append one prediction/outcome pair to the rolling window. Mutates and returns
 * `data`; tolerates a learning.json that predates `correlationWindow`.
 * `predictedRisk` must be computed from history BEFORE this completion (no
 * leakage); `bad` is whether the run failed or missed its declared criteria.
 * @param {object} data - learning data
 * @param {{ taskType?:string, tier?:string, predictedRisk:boolean, bad:boolean }} sample
 *   predictedRisk — did the enriched failure signal flag this run's tier as
 *   risky, computed from history BEFORE this completion (a genuine prediction,
 *   not leakage). bad — did the run actually fail or miss its declared criteria.
 */
export function recordCorrelationSample(data, { taskType, tier, predictedRisk, bad } = {}) {
  if (!data) return data;
  if (!Array.isArray(data.correlationWindow)) data.correlationWindow = [];

  data.correlationWindow.push({
    taskType: taskType ?? null,
    tier: tier ?? null,
    predictedRisk: !!predictedRisk,
    bad: !!bad,
    recordedAt: new Date().toISOString()
  });

  if (data.correlationWindow.length > MAX_CORRELATION_SAMPLES) {
    data.correlationWindow = data.correlationWindow.slice(-MAX_CORRELATION_SAMPLES);
  }
  return data;
}

/**
 * Correlation-quality score for a window of prediction/outcome pairs: the
 * Matthews (phi) coefficient, robust to class imbalance unlike raw accuracy.
 *
 * Returns `score: null` (NOT 0) when a denominator factor is 0 (a predicted or
 * actual class is absent): "not measurable" must not collapse into "zero
 * correlation".
 *
 * The window is deliberately CROSS-taskType: calibration is a property of the
 * enrichment mechanism, and a global window reaches confident counts far sooner
 * than per-type windows.
 *
 * @returns {{ score:number|null, sampleCount:number, confident:boolean,
 *   matrix:{ tp:number, fp:number, fn:number, tn:number } }}
 */
export function computeCorrelationQuality(window, { minSamples = MIN_CORRELATION_SAMPLES } = {}) {
  const samples = Array.isArray(window) ? window : [];
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const s of samples) {
    const risk = !!s?.predictedRisk;
    const bad = !!s?.bad;
    if (risk && bad) tp++;
    else if (risk && !bad) fp++;
    else if (!risk && bad) fn++;
    else tn++;
  }

  const denomSq = (tp + fp) * (tp + fn) * (tn + fp) * (tn + fn);
  const score = denomSq === 0 ? null : (tp * tn - fp * fn) / Math.sqrt(denomSq);
  const sampleCount = samples.length;

  return {
    score,
    sampleCount,
    // A null score (degenerate window) is never "confident".
    confident: score !== null && sampleCount >= minSamples,
    matrix: { tp, fp, fn, tn }
  };
}

/** True when the signal has proven, confident correlation: the `suggestModelTier` aggressiveness gate (#2344). */
export function isCorrelationProven(quality, threshold = CORRELATION_QUALITY_THRESHOLD) {
  return !!quality?.confident && quality.score !== null && quality.score > threshold;
}
