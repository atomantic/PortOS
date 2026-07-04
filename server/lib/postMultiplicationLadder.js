/**
 * POST progressive multiplication ladder (pure, side-effect-free).
 *
 * The plain multiplication drill used to start at a fixed 2-digit × 2-digit
 * difficulty (e.g. `56 × 91`) for everyone, which is far too hard as a warm-up.
 * This module replaces that with a mastery-gated difficulty ladder: a new user
 * starts at single-digit × single-digit and only climbs to the next rung once
 * they have demonstrated *speed* mastery (fast AND accurate) at the current one.
 *
 * The ladder grows the way the user asked for it: add a digit, then add a
 * factor, alternating so mental load rises gently rather than jumping straight
 * to large products.
 *
 * Unlike the generic `postAdaptive.js` knob (which only tunes a symmetric
 * `maxDigits`), this ladder can express asymmetric (1×2) and multi-factor
 * (1×1×1) rungs, which is what a real "ramp up" needs.
 *
 * Progression is derived from scored session history: each generated drill
 * stamps its `level` into the task config, so later we can bucket answered
 * questions by level and measure per-level accuracy + response time.
 *
 * The generic mastery/floor machinery lives in `postProgression.js` (shared
 * with the cognitive-drill ladders); this module is the multiplication-specific
 * ladder + the speed-target curve, wired onto that helper. Its public API is
 * unchanged — it is the reference ladder the shared helper was extracted from.
 */

import { createProgression, PROGRESSION_MASTERY_DEFAULTS } from './postProgression.js';

// Ordered difficulty ladder. Each entry lists the digit-count of every factor
// in a problem, so `[1, 2]` = single-digit × double-digit and `[1, 1, 1]` =
// three single-digit factors. Rungs are hand-authored (not computed) so the
// progression is explicit and easy to reason about / test.
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
  // Answered questions accumulated at a level before it can be judged mastered.
  // ~1–2 sessions of the default 10-question drill.
  minSamples: 12,
  // Fraction of answered questions that must be correct.
  targetAccuracy: 0.9,
  // Speed target scales with total digit count so harder rungs get more time.
  // A [1,1] rung (2 total digits) targets ~4.4s but is floored at minTargetMs.
  baseMsPerFactorDigit: 2200,
  minTargetMs: 4000,
  // Stats window (days) the mastery signal is read over. Mastery is judged over
  // this rolling window so "fast enough to advance" reflects recent performance,
  // NOT stale reps — but earned rungs never age out (see `floorLevel` below).
  windowDays: 30,
  // Answered questions slower than this are clamped before averaging, so one
  // walked-away-from-the-tab answer can't inflate a rung's avgResponseMs and
  // make it feel un-masterable. Mirrors scoreDrill's per-question clamp; set at
  // the default multiplication time limit (120s).
  responseMsCap: 120000,
};

/**
 * The factor-digit spec for a ladder level (clamped into range).
 * @returns {number[]} e.g. [1, 2]
 */
export function ladderFactors(level) {
  return MULTIPLICATION_LADDER[clampMultiplicationLevel(level)];
}

/**
 * Short human label for a level, e.g. `1×2-digit` or `1×1×1-digit`.
 */
export function describeMultiplicationLevel(level) {
  return `${ladderFactors(level).join('×')}-digit`;
}

// Per-level response-time target (ms): scales with the total number of digits
// across all factors, floored at `minTargetMs`. This is the multiplication
// ladder's speed curve, handed to the shared helper so it can gate mastery on
// speed (fast AND accurate) rather than accuracy alone.
function multiplicationSpeedTarget(level, opts) {
  const options = { ...MASTERY_DEFAULTS, ...opts };
  const totalDigits = MULTIPLICATION_LADDER[level].reduce((a, b) => a + b, 0);
  return Math.max(options.minTargetMs, options.baseMsPerFactorDigit * totalDigits);
}

// Shared progression resolver for the multiplication ladder. `mastery` carries
// the extra `baseMsPerFactorDigit`/`minTargetMs` fields the speed curve reads;
// the generic helper ignores keys it doesn't use.
const progression = createProgression({
  levels: MULTIPLICATION_LADDER,
  describeLevel: describeMultiplicationLevel,
  mastery: { ...PROGRESSION_MASTERY_DEFAULTS, ...MASTERY_DEFAULTS },
  speedTargetForLevel: multiplicationSpeedTarget,
});

export function clampMultiplicationLevel(level) {
  return progression.clampLevel(level);
}

/**
 * Per-question response-time target (ms) for a level. Scales with the total
 * number of digits across all factors, floored at `minTargetMs`.
 */
export function speedTargetMs(level, opts = MASTERY_DEFAULTS) {
  return progression.speedTargetMs(level, opts);
}

/**
 * Whether a level's aggregated stat clears the mastery bar: enough samples,
 * high accuracy, and average response time within the level's speed target.
 * @param {{samples?: number, accuracy?: number, avgResponseMs?: number}} stat
 */
export function isLevelMastered(stat, level, opts = MASTERY_DEFAULTS) {
  return progression.isLevelMastered(stat, level, opts);
}

/**
 * Resolve the user's current ladder level from per-level performance stats.
 *
 * Walks the ladder up from the earned `floorLevel` and stops at the first rung
 * the user has NOT yet mastered (over the recent window) — so they stay there
 * accumulating fast-and-accurate reps until the speed bar is cleared, then
 * advance. Returns a transparent explainer with every rung's status so the UI
 * can show the ladder.
 *
 * `floorLevel` is the highest rung the user has EVER generated (all-time, not
 * windowed). It is the anti-demotion floor: because mastery is judged over a
 * rolling window, a rung's samples fall to 0 once its evidence ages out — but
 * you only ever reach a higher rung by having cleared the ones below it, so
 * earned progress must not be lost when it ages out.
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
    // Re-key each rung to the multiplication shape (`factors` from the generic
    // `descriptor`), preserving the exact fields the ladder always exposed.
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
