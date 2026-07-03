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
 */

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
  // Stats window (days) the mastery signal is read over.
  windowDays: 30,
};

export function clampMultiplicationLevel(level) {
  const n = Number.isInteger(level) ? level : 0;
  return Math.min(MAX_MULTIPLICATION_LEVEL, Math.max(0, n));
}

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

/**
 * Per-question response-time target (ms) for a level. Scales with the total
 * number of digits across all factors, floored at `minTargetMs`.
 */
export function speedTargetMs(level, opts = MASTERY_DEFAULTS) {
  const options = { ...MASTERY_DEFAULTS, ...opts };
  const totalDigits = ladderFactors(level).reduce((a, b) => a + b, 0);
  return Math.max(options.minTargetMs, options.baseMsPerFactorDigit * totalDigits);
}

/**
 * Whether a level's aggregated stat clears the mastery bar: enough samples,
 * high accuracy, and average response time within the level's speed target.
 * @param {{samples?: number, accuracy?: number, avgResponseMs?: number}} stat
 */
export function isLevelMastered(stat, level, opts = MASTERY_DEFAULTS) {
  const options = { ...MASTERY_DEFAULTS, ...opts };
  const samples = Number.isFinite(stat?.samples) ? stat.samples : 0;
  const accuracy = Number.isFinite(stat?.accuracy) ? stat.accuracy : 0;
  const avgResponseMs = Number.isFinite(stat?.avgResponseMs) ? stat.avgResponseMs : 0;
  if (samples < options.minSamples) return false;
  if (accuracy < options.targetAccuracy) return false;
  // avgResponseMs of 0 means no timed samples — never treat as "instant mastery".
  if (avgResponseMs <= 0) return false;
  return avgResponseMs <= speedTargetMs(level, options);
}

/**
 * Resolve the user's current ladder level from per-level performance stats.
 *
 * Walks the ladder from the bottom and stops at the first rung the user has NOT
 * yet mastered — so they stay there accumulating fast-and-accurate reps until
 * the speed bar is cleared, then advance. Returns a transparent explainer with
 * every rung's status so the UI can show the ladder.
 *
 * @param {Record<number|string, {samples:number, accuracy:number, avgResponseMs:number}>} levelStats
 * @returns {{level, factors, label, atHardest, currentMastered, levels}}
 */
export function resolveMultiplicationLevel(levelStats = {}, opts = {}) {
  const options = { ...MASTERY_DEFAULTS, ...opts };
  const levels = MULTIPLICATION_LADDER.map((factors, level) => {
    const stat = levelStats?.[level] || levelStats?.[String(level)] || {};
    const samples = Number.isFinite(stat.samples) ? stat.samples : 0;
    const accuracy = Number.isFinite(stat.accuracy) ? stat.accuracy : 0;
    const avgResponseMs = Number.isFinite(stat.avgResponseMs) ? stat.avgResponseMs : 0;
    const targetMs = speedTargetMs(level, options);
    return {
      level,
      factors,
      label: describeMultiplicationLevel(level),
      samples,
      accuracy,
      avgResponseMs,
      targetMs,
      mastered: isLevelMastered({ samples, accuracy, avgResponseMs }, level, options),
    };
  });

  let level = 0;
  while (level < MAX_MULTIPLICATION_LEVEL && levels[level].mastered) level += 1;

  const current = levels[level];
  return {
    level,
    factors: current.factors,
    label: current.label,
    atHardest: level >= MAX_MULTIPLICATION_LEVEL,
    currentMastered: current.mastered,
    levels,
  };
}
