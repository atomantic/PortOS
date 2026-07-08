// Writers Room — pure logic for the multi-pass Polish loop (#2173).
//
// Side-effect-free helpers: turn an `evaluate` analysis result into a numeric
// quality score, decide keep-vs-revert against a prior score, and decide when
// to stop the loop (max cycles / plateau). Kept here (not in the service) so the
// gate/plateau math is unit-testable without touching the LLM or the filesystem.

// Map the evaluate stage's issue severities (minor|moderate|major) onto the
// same penalty weights the pipeline editorial score uses (low|medium|high). A
// draft starts at 100 and loses points per open issue: a `major` costs as much
// as a dozen `minor` nits. Mirrors DEFAULT_SEVERITY_WEIGHTS in
// lib/editorial/severityConfig.js so the two quality models stay aligned.
export const EVAL_SEVERITY_WEIGHTS = Object.freeze({ major: 12, moderate: 5, minor: 1 });

// Cut types the Polish loop auto-applies without human review. Mirrors
// SAFE_CUT_TYPES in lib/editorial/checkInfra.js (OVER-EXPLAIN + REDUNDANT).
export const SAFE_POLISH_CUT_TYPES = Object.freeze(['OVER-EXPLAIN', 'REDUNDANT']);

// Loop defaults. `cycles` is how many polish passes to run; `minKeepDelta` is
// the minimum score improvement required to KEEP a revised body over the prior
// one (below it we revert — a change that didn't measurably help isn't worth the
// churn); `plateauDelta` stops the loop early once a kept improvement is too
// small to be worth another (expensive) cycle.
export const POLISH_DEFAULTS = Object.freeze({
  cycles: 1,
  maxCycles: 3,
  minKeepDelta: 1,
  plateauDelta: 2,
});

/**
 * Score an `evaluate` analysis result. Higher is better (100 = flawless).
 * Absent/invalid result → null (NOT 0) so callers can distinguish "no
 * evaluation" from "a genuinely terrible draft that scored 0". Only OPEN issues
 * penalize; strengths do not add points (a draft can't exceed 100).
 *
 * @param {{ issues?: Array<{ severity?: string }> }} result
 * @returns {number | null} 0..100, or null when there is nothing to score.
 */
export function scoreEvaluation(result) {
  if (!result || typeof result !== 'object') return null;
  const issues = Array.isArray(result.issues) ? result.issues : [];
  let penalty = 0;
  for (const issue of issues) {
    const weight = EVAL_SEVERITY_WEIGHTS[issue?.severity];
    // An unknown/absent severity still counts as a nit so a mislabeled issue
    // isn't silently free.
    penalty += Number.isFinite(weight) ? weight : EVAL_SEVERITY_WEIGHTS.minor;
  }
  return Math.max(0, Math.min(100, 100 - penalty));
}

/**
 * Decide whether a revised body should be KEPT over the prior one. A revision
 * is kept only when it improves the score by at least `minKeepDelta`. When
 * either score is null (an evaluation failed) we KEEP conservatively only if the
 * revision produced *a* score and the prior had none — otherwise revert, because
 * we can't prove the change helped.
 *
 * @returns {{ keep: boolean, delta: number|null, reason: string }}
 */
export function decideKeepRevert(beforeScore, afterScore, { minKeepDelta = POLISH_DEFAULTS.minKeepDelta } = {}) {
  const beforeOk = Number.isFinite(beforeScore);
  const afterOk = Number.isFinite(afterScore);
  if (!afterOk) return { keep: false, delta: null, reason: 'no-after-score' };
  if (!beforeOk) return { keep: true, delta: null, reason: 'no-before-score' };
  const delta = afterScore - beforeScore;
  if (delta >= minKeepDelta) return { keep: true, delta, reason: 'improved' };
  return { keep: false, delta, reason: delta <= 0 ? 'regressed' : 'below-threshold' };
}

/**
 * Decide whether the loop should stop AFTER the just-completed cycle. Stops when
 * the max cycle count is reached, OR the last cycle was reverted (a revert means
 * the model couldn't improve on the current body — another cycle over the SAME
 * body is unlikely to differ), OR the kept improvement was below `plateauDelta`
 * (diminishing returns). Returns `{ stop, reason }`.
 *
 * @param {{ cycle: number, cycles: number, kept: boolean, delta: number|null, plateauDelta?: number }} args
 */
export function shouldStopPolish({ cycle, cycles, kept, delta, plateauDelta = POLISH_DEFAULTS.plateauDelta }) {
  if (cycle >= cycles) return { stop: true, reason: 'max-cycles' };
  if (!kept) return { stop: true, reason: 'reverted' };
  if (Number.isFinite(delta) && delta < plateauDelta) return { stop: true, reason: 'plateau' };
  return { stop: false, reason: 'continue' };
}

/**
 * Clamp a requested cycle count to [1, maxCycles], defaulting a missing/invalid
 * value to POLISH_DEFAULTS.cycles. Used by both the route (input coercion) and
 * the runner so the two never disagree on the effective count.
 */
export function resolveCycles(requested, { maxCycles = POLISH_DEFAULTS.maxCycles } = {}) {
  const n = Number(requested);
  if (!Number.isInteger(n) || n < 1) return POLISH_DEFAULTS.cycles;
  return Math.min(n, maxCycles);
}
