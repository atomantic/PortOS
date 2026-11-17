/**
 * POST progressive multiplication ladder (pure).
 *
 * mastery-gated difficulty rungs (`[1,1]` → `[1,2]` → `[1,1,1]` → …) resolved from per-level speed+accuracy stats, so the plain multiplication drill ramps up from single-digit × single-digit (it once started everyone at a fixed 2-digit × 2-digit, far too hard as a warm-up) and climbs only after *speed* mastery (fast AND accurate) at the current rung. On by default. It alternates adding a digit and adding a factor so mental load rises gently, and unlike `postAdaptive.js` (symmetric `maxDigits`) it can express asymmetric (1×2) and multi-factor (1×1×1) rungs. Progression derives from scored session history: each drill stamps its `level` into the task config. The generic mastery/floor machinery lives in `postProgression.js` (shared with the cognitive-drill ladders); this is the multiplication-specific ladder plus speed-target curve, the reference ladder the helper was extracted from.
 */

import { createProgression, PROGRESSION_MASTERY_DEFAULTS } from './postProgression.js';

// Ordered difficulty ladder: each entry lists every factor's digit count (`[1, 2]` = single × double, `[1, 1, 1]` = three single-digit factors). Hand-authored so the progression is explicit and testable.
export const MULTIPLICATION_LADDER = [
  [1, 1], // 7 × 8
  [1, 2], // 7 × 84
  [1, 1, 1], // 6 × 7 × 8
  [2, 2], // 56 × 84
  [1, 2, 2], // 7 × 56 × 84
  [2, 3], // 56 × 842
  [1, 1, 1, 1], // 6 × 7 × 8 × 9
  [3, 3], // 566 × 191
];

export const MAX_MULTIPLICATION_LEVEL = MULTIPLICATION_LADDER.length - 1;

export const MASTERY_DEFAULTS = {
  // Answered questions accumulated at a level before it can be judged mastered (~1-2 sessions of the default 10-question drill).
  minSamples: 12,
  // Fraction of answered questions that must be correct.
  targetAccuracy: 0.9,
  // Speed target scales with total digit count: a [1,1] rung targets ~4.4s but is floored at minTargetMs.
  baseMsPerFactorDigit: 2200,
  minTargetMs: 4000,
  // Stats window (days) mastery is read over, so "fast enough to advance" reflects recent performance, NOT stale reps (earned rungs never age out: see `floorLevel`).
  windowDays: 30,
  // Answered questions slower than this are clamped before averaging so one walked-away tab can't inflate a rung's avgResponseMs (mirrors scoreDrill's clamp; the default 120s limit).
  responseMsCap: 120000,
};

/** The factor-digit spec for a ladder level (clamped), e.g. [1, 2]. */
export function ladderFactors(level) {
  return MULTIPLICATION_LADDER[clampMultiplicationLevel(level)];
}

/** Short human label for a level, e.g. `1×2-digit` or `1×1×1-digit`. */
export function describeMultiplicationLevel(level) {
  return `${ladderFactors(level).join('×')}-digit`;
}

// Per-level response-time target (ms): scales with total digits across factors, floored at `minTargetMs`; the speed curve handed to the shared helper to gate mastery on speed, not accuracy alone.
function multiplicationSpeedTarget(level, opts) {
  const options = { ...MASTERY_DEFAULTS, ...opts };
  const totalDigits = MULTIPLICATION_LADDER[level].reduce((a, b) => a + b, 0);
  return Math.max(options.minTargetMs, options.baseMsPerFactorDigit * totalDigits);
}

// Shared progression resolver; `mastery` carries the extra `baseMsPerFactorDigit`/`minTargetMs` fields the speed curve reads (the generic helper ignores keys it doesn't use).
const progression = createProgression({
  levels: MULTIPLICATION_LADDER,
  describeLevel: describeMultiplicationLevel,
  mastery: { ...PROGRESSION_MASTERY_DEFAULTS, ...MASTERY_DEFAULTS },
  speedTargetForLevel: multiplicationSpeedTarget,
});

export function clampMultiplicationLevel(level) {
  return progression.clampLevel(level);
}

/** Per-question response-time target (ms) for a level: scales with total digits across factors, floored at `minTargetMs`. */
export function speedTargetMs(level, opts = MASTERY_DEFAULTS) {
  return progression.speedTargetMs(level, opts);
}

/** Whether a level's aggregated stat clears the mastery bar: enough samples, high accuracy, and average response time within the speed target.
 * @param {{samples?: number, accuracy?: number, avgResponseMs?: number}} stat
 */
export function isLevelMastered(stat, level, opts = MASTERY_DEFAULTS) {
  return progression.isLevelMastered(stat, level, opts);
}

/**
 * Resolve the user's current ladder level from per-level stats: walk up from the earned `floorLevel` and stop at the first rung NOT yet mastered over the recent window, returning an explainer with every rung's status for the UI.
 * `floorLevel` is the highest rung EVER generated (all-time): the anti-demotion floor, since a rung's samples fall to 0 once evidence ages out but a higher rung is only reached by clearing those below.
 *
 * @param {Record<number|string, {samples:number, accuracy:number, avgResponseMs:number}>} levelStats
 * @param {object} [opts] - override MASTERY_DEFAULTS thresholds
 * @param {number} [floorLevel=0] - highest all-time-active rung (earned floor)
 * @returns {{level, factors, label, atHardest, currentMastered, floorLevel, levels}}
 */
export function resolveMultiplicationLevel(levelStats = {}, opts = {}, floorLevel = 0) {
  const res = progression.resolveLevel(levelStats, opts, floorLevel);
  return {
    level: res.level,
    factors: MULTIPLICATION_LADDER[res.level],
    label: res.label,
    atHardest: res.atHardest,
    currentMastered: res.currentMastered,
    floorLevel: res.floorLevel,
    // Re-key each rung to the multiplication shape (`factors` from the generic `descriptor`), preserving the fields the ladder always exposed.
    levels: res.levels.map(rung => ({
      level: rung.level,
      factors: rung.descriptor,
      label: rung.label,
      samples: rung.samples,
      accuracy: rung.accuracy,
      avgResponseMs: rung.avgResponseMs,
      targetMs: rung.targetMs,
      mastered: rung.mastered,
    })),
  };
}
