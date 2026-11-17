/**
 * Estimation-drill precision copy: `estimationToleranceText(tolerancePct)` is the one line a drill shows to say how precise to be.
 *
 * e.g. "Within 10% counts — 2 significant figures is close enough". A bare "309 - 925" doesn't say how precise to be, and a percentage of an answer not yet worked out isn't actionable mid-drill, so the grading band becomes
 * significant figures (scale-free: rounding to `n` costs at most 0.5 x 10^(1-n) relative error, ~50% at 1, ~5% at 2, ~0.5% at 3; the smallest `n` fitting the band is the precision required).
 * The band comes from `resolveEstimationTolerancePct` (`server/lib/postScoring.js`), the resolver both graders use, so the copy can't claim a band the ✓/✗ didn't apply. Rendered by `components/meatspace/post/EstimationPrecision.jsx`. Pure, DOM-free.
 */

import { resolveEstimationTolerancePct } from '../../../server/lib/postScoring.js';
import { pluralize } from './textUtils.js';

// 6 covers a 0.00005% band, past anything a person estimates; the cap only stops a tolerance of 0 (exact match) from spinning the loop.
const MAX_SIGNIFICANT_FIGURES = 6;

/** Fewest significant figures whose worst-case rounding error still lands inside the tolerance band. */
function significantFiguresFor(tolerancePct) {
  const tolerance = tolerancePct / 100;
  for (let n = 1; n < MAX_SIGNIFICANT_FIGURES; n++) {
    if (0.5 * Math.pow(10, 1 - n) <= tolerance) return n;
  }
  return MAX_SIGNIFICANT_FIGURES;
}

/** One line of drill copy stating the grading rule and the precision it implies, e.g. "Within 10% counts — 2 significant figures is close enough". */
export function estimationToleranceText(tolerancePct) {
  const pct = resolveEstimationTolerancePct(tolerancePct);
  return `Within ${pct}% counts — ${pluralize(significantFiguresFor(pct), 'significant figure')} is close enough`;
}
