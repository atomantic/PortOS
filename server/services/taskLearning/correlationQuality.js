/**
 * Task Learning — correlation-quality measurement window (issue #2344, carved
 * out of #2329).
 *
 * The enriched failure signatures (#2329/#2332) let routing steer away from a
 * tier that is freshly failing. But an avoidance signal is only worth acting on
 * aggressively if it actually PREDICTS bad outcomes — otherwise the system
 * over-corrects on noise. This module measures exactly that: over a rolling
 * window it correlates each run's *prediction* (did the enriched signal flag
 * this run's tier as risky, based on history BEFORE the run?) with its *actual
 * outcome* (did the run fail / miss its declared success criteria?), and exposes
 * a correlation-quality score.
 *
 * `suggestModelTier` (routing.js) gates auto-adjustment aggressiveness on that
 * score clearing `CORRELATION_QUALITY_THRESHOLD` (>0.8): until the signal has
 * demonstrably-good correlation over enough samples, avoidance requires a higher
 * failure-sample bar before it steers selection.
 *
 * Pure — no I/O except the thin `getCorrelationQuality()` loader.
 */

import { loadLearningData } from './store.js';

// Bounds `correlationWindow` growth the same way `failureSignatures.recent` and
// `recentUnknownErrors` do — a rolling window, not an unbounded ledger.
const MAX_CORRELATION_SAMPLES = 200;

// Below this many samples the phi coefficient is too noisy to gate on — a score
// computed from a handful of runs can swing wildly. `confident` stays false and
// the routing gate treats the signal as unproven.
export const MIN_CORRELATION_SAMPLES = 20;

// Auto-adjustment aggressiveness gate: the enriched signal must correlate with
// outcomes ABOVE this (Matthews/phi coefficient, [-1,1]) before routing acts on
// it aggressively (issue #2344).
export const CORRELATION_QUALITY_THRESHOLD = 0.8;

/**
 * Append one prediction/outcome pair to the rolling correlation window.
 * Pure — mutates and returns `data`. Additive + back-compat: tolerates a
 * learning.json that predates the `correlationWindow` key.
 *
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
 * Compute the correlation-quality score for a window of prediction/outcome
 * pairs. Pure. Uses the Matthews correlation coefficient (the phi coefficient
 * for two binary variables — predictedRisk vs bad), which is robust to class
 * imbalance (most runs succeed) in a way raw accuracy is not.
 *
 * Sentinel discipline: returns `score: null` (NOT 0) when a denominator factor
 * is 0 — i.e. a predicted or actual class is entirely absent from the window
 * (all runs predicted-safe, or none failed). "Not measurable" must never
 * collapse into "measured zero correlation".
 *
 * Scope: the window is deliberately CROSS-taskType — one global "is the enriched
 * signal trustworthy" gauge, not a per-taskType score. `suggestModelTier(taskType)`
 * gates a per-taskType decision on it intentionally: the signal's calibration is
 * a property of the enrichment mechanism, not of any one task type, and a global
 * window reaches confident sample counts far sooner than N per-type windows would.
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
    // Gate-ready: enough samples AND a measurable score. A null score (degenerate
    // window) is never "confident", so the routing gate stays conservative.
    confident: score !== null && sampleCount >= minSamples,
    matrix: { tp, fp, fn, tn }
  };
}

/**
 * True when the enriched failure signal has proven, high-confidence correlation
 * with outcomes — the gate `suggestModelTier` uses to decide whether to apply
 * tier-avoidance aggressively (issue #2344). A `null`/low/low-confidence score
 * returns false, keeping auto-adjustment conservative until the signal earns it.
 */
export function isCorrelationProven(quality, threshold = CORRELATION_QUALITY_THRESHOLD) {
  return !!quality?.confident && quality.score !== null && quality.score > threshold;
}

/**
 * Load learning data and compute the current correlation-quality gauge.
 * Thin async wrapper over the pure `computeCorrelationQuality`.
 */
export async function getCorrelationQuality(options = {}) {
  const data = await loadLearningData();
  return computeCorrelationQuality(data.correlationWindow, options);
}
