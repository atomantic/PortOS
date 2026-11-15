/**
 * Estimation-drill precision copy.
 *
 * `estimationToleranceText(tolerancePct)` → the one line an estimation drill shows to say how precise
 * to be, e.g. "Within 10% counts — 2 significant figures is close enough". Converts the grading band
 * into significant figures (scale-free: rounding to `n` of them is worst-case `0.5 x 10^(1-n)` off, so
 * the smallest `n` that fits the band IS the precision required), because a percentage of an answer
 * you have not worked out yet is not actionable mid-drill. Reads the band through
 * `resolveEstimationTolerancePct` (`server/lib/postScoring.js`), the same resolver both graders use,
 * so the copy can never claim a band the ✓/✗ did not apply. Rendered by
 * `components/meatspace/post/EstimationPrecision.jsx`. Pure, DOM-free.
 *
 * Estimation drills grade within a percentage band of the exact answer, but a
 * bare "309 - 925" tells the drillee nothing about how precise to be — are they
 * estimating to the nearest 10, or the nearest 100? A percentage is also not
 * directly actionable mid-drill, because it is a percentage of an answer they
 * have not worked out yet.
 *
 * Significant figures are the scale-free way to say it. Rounding a value to `n`
 * significant figures costs at most half a unit in the nth place, so the worst
 * relative error is 0.5 x 10^(1-n) regardless of the answer's magnitude: ~50%
 * at 1 sig fig, ~5% at 2, ~0.5% at 3. The smallest `n` whose worst case fits
 * inside the tolerance band is the precision the drillee actually has to hit.
 *
 * The band itself comes from `server/lib/postScoring.js` — the same resolver
 * grading reads, so this copy can never claim a band the ✓/✗ didn't use.
 */

import { resolveEstimationTolerancePct } from '../../../server/lib/postScoring.js';
import { pluralize } from './textUtils.js';

// 6 covers a 0.00005% band — far past the 1-50% the config allows, and past
// anything a person estimates in their head. The cap only exists so a tolerance
// of 0 (exact match) can't spin the loop.
const MAX_SIGNIFICANT_FIGURES = 6;

/**
 * Fewest significant figures whose worst-case rounding error still lands inside
 * the tolerance band.
 */
function significantFiguresFor(tolerancePct) {
  const tolerance = tolerancePct / 100;
  for (let n = 1; n < MAX_SIGNIFICANT_FIGURES; n++) {
    if (0.5 * Math.pow(10, 1 - n) <= tolerance) return n;
  }
  return MAX_SIGNIFICANT_FIGURES;
}

/**
 * One line of drill copy stating both the grading rule and the precision it
 * implies, e.g. "Within 10% counts — 2 significant figures is close enough".
 */
export function estimationToleranceText(tolerancePct) {
  const pct = resolveEstimationTolerancePct(tolerancePct);
  return `Within ${pct}% counts — ${pluralize(significantFiguresFor(pct), 'significant figure')} is close enough`;
}
