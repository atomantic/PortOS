/**
 * Generic POST mastery-gated progression ladder (pure, side-effect-free).
 *
 * Extracted from `postMultiplicationLadder.js` so ANY drill — not just
 * multiplication — can declare an ordered level list plus a mastery predicate
 * and get level resolution (with an anti-demotion floor) for free.
 *
 * A ladder is an ordered array of opaque "rung descriptors" (for multiplication
 * a per-factor digit-count array; for a cognitive drill the generator-config
 * knobs at that difficulty). `createProgression` turns a ladder definition into
 * the same resolver shape the multiplication ladder always exposed:
 *
 *   - `clampLevel(level)`         — clamp into [0, maxLevel]
 *   - `speedTargetMs(level, o)`   — per-level response-time target (or null)
 *   - `describeLevel(level)`      — short human label
 *   - `isLevelMastered(stat, l)`  — samples + accuracy (+ optional speed) gate
 *   - `resolveLevel(stats, o, f)` — walk up from the earned floor to the first
 *                                   un-mastered rung; returns a UI explainer
 *
 * Mastery is judged over a rolling window, but a rung's earned progress must
 * survive its evidence aging out — that's the `floorLevel` (highest rung ever
 * reached, all-time). Without it a user grinding rung 3 would snap back to 0
 * the day their earliest rung-0 sessions crossed the window cutoff.
 *
 * A ladder that supplies `speedTargetForLevel` is *speed-gated* (mastery also
 * requires the level's average response time to clear the target, and a level
 * with no timed samples is never "instantly mastered") — this is the
 * multiplication behaviour. A ladder without it is *accuracy-only*: mastery is
 * purely samples + accuracy, which is what the cognitive drills use (their
 * difficulty ramp lives in the rung knobs — a higher n, a longer span, a bigger
 * grid — not in a per-question speed bar).
 */

// Shared mastery thresholds. Ladder definitions override any subset via
// `def.mastery`. `windowDays`/`responseMsCap` are consumed by the service that
// aggregates per-level stats, not by this pure module, but they live here so a
// ladder has one source of truth for its thresholds.
export const PROGRESSION_MASTERY_DEFAULTS = {
  // Answered samples accumulated at a level before it can be judged mastered.
  minSamples: 12,
  // Fraction of samples that must be correct (accuracy 0-1).
  targetAccuracy: 0.9,
  // Rolling window (days) the mastery signal is read over. Earned rungs never
  // age out below the floor (see resolveLevel).
  windowDays: 30,
  // Samples slower than this are clamped before averaging, so one walked-away
  // answer can't inflate a level's avgResponseMs and block mastery.
  responseMsCap: 120000,
};

export function clampLevel(level, maxLevel) {
  const n = Number.isInteger(level) ? level : 0;
  return Math.min(maxLevel, Math.max(0, n));
}

/**
 * Build a progression resolver from a ladder definition.
 *
 * @param {object} def
 * @param {any[]} def.levels - ordered rung descriptors (opaque to this module)
 * @param {(level:number)=>string} def.describeLevel - short label for a rung
 * @param {object} [def.mastery] - overrides for PROGRESSION_MASTERY_DEFAULTS
 * @param {(level:number, opts:object)=>number|null} [def.speedTargetForLevel] -
 *   when it returns a positive finite ms target, mastery additionally requires
 *   `avgResponseMs` in `(0, target]`; when null/undefined/absent, mastery is
 *   accuracy-only.
 */
export function createProgression(def) {
  const levels = def.levels;
  const maxLevel = levels.length - 1;
  const masteryDefaults = { ...PROGRESSION_MASTERY_DEFAULTS, ...(def.mastery || {}) };
  const speedTargetForLevel = typeof def.speedTargetForLevel === 'function' ? def.speedTargetForLevel : null;

  const clamp = level => clampLevel(level, maxLevel);
  const describeLevel = level => def.describeLevel(clamp(level));

  const speedTargetMs = (level, opts = masteryDefaults) => {
    if (!speedTargetForLevel) return null;
    return speedTargetForLevel(clamp(level), { ...masteryDefaults, ...opts });
  };

  const isLevelMastered = (stat, level, opts = masteryDefaults) => {
    const options = { ...masteryDefaults, ...opts };
    const samples = Number.isFinite(stat?.samples) ? stat.samples : 0;
    const accuracy = Number.isFinite(stat?.accuracy) ? stat.accuracy : 0;
    const avgResponseMs = Number.isFinite(stat?.avgResponseMs) ? stat.avgResponseMs : 0;
    if (samples < options.minSamples) return false;
    if (accuracy < options.targetAccuracy) return false;
    const target = speedTargetForLevel ? speedTargetForLevel(clamp(level), options) : null;
    if (target != null && Number.isFinite(target) && target > 0) {
      // avgResponseMs of 0 means no timed samples — never "instant mastery".
      if (avgResponseMs <= 0) return false;
      return avgResponseMs <= target;
    }
    return true;
  };

  /**
   * Resolve the current level from per-level performance stats. Walks up from
   * the earned `floorLevel` and stops at the first un-mastered rung. Returns a
   * transparent explainer with every rung's status so the UI can render the
   * ladder.
   */
  const resolveLevel = (levelStats = {}, opts = {}, floorLevel = 0) => {
    const options = { ...masteryDefaults, ...opts };
    const floor = clamp(floorLevel);
    const rungs = levels.map((descriptor, level) => {
      const stat = levelStats?.[level] || levelStats?.[String(level)] || {};
      const samples = Number.isFinite(stat.samples) ? stat.samples : 0;
      const accuracy = Number.isFinite(stat.accuracy) ? stat.accuracy : 0;
      const avgResponseMs = Number.isFinite(stat.avgResponseMs) ? stat.avgResponseMs : 0;
      const targetMs = speedTargetForLevel ? speedTargetForLevel(level, options) : null;
      return {
        level,
        descriptor,
        label: def.describeLevel(level),
        samples,
        accuracy,
        avgResponseMs,
        targetMs,
        mastered: isLevelMastered({ samples, accuracy, avgResponseMs }, level, options),
      };
    });

    // Advance from the earned floor while the current rung's recent performance
    // clears the bar. Starting at `floor` prevents involuntary demotion of
    // rungs whose window evidence has aged out.
    let level = floor;
    while (level < maxLevel && rungs[level].mastered) level += 1;

    // Every rung strictly below the resolved level has been cleared, so render
    // it mastered even if its recent window is empty.
    for (const rung of rungs) {
      if (rung.level < level) rung.mastered = true;
    }

    const current = rungs[level];
    return {
      level,
      label: current.label,
      atHardest: level >= maxLevel,
      currentMastered: current.mastered,
      floorLevel: floor,
      levels: rungs,
    };
  };

  return {
    levels,
    maxLevel,
    masteryDefaults,
    clampLevel: clamp,
    describeLevel,
    speedTargetMs,
    isLevelMastered,
    resolveLevel,
  };
}

// =============================================================================
// COGNITIVE DRILL LADDERS
// =============================================================================
//
// Each ladder is an ordered list of generator-config knob objects: rung N's
// object is spread into the drill's requested config at generation time (via
// meatspacePost.js resolveDrillConfig), so climbing the ladder literally makes
// the generated drill harder. `describe` turns a rung into a short label for
// the config/preview badge. reaction-time is deliberately absent — it's a
// measurement baseline, not a skill ladder.
//
// Mastery is accuracy-only (no per-question speed gate): the difficulty ramp is
// the knob itself (higher n, faster stimulus, longer span, bigger grid, more
// trials), so "mastered this rung" means sustained high accuracy AT that knob
// setting. For n-back the accuracy stamped per task is the balanced /
// signal-detection accuracy from #2094, so the do-nothing exploit can't bank a
// rung.

export const COGNITIVE_MASTERY_DEFAULTS = {
  // A "sample" here is one completed drill at a level (not one answered
  // question), so a handful of clean runs is enough to advance.
  minSamples: 3,
  targetAccuracy: 0.85,
  windowDays: 30,
};

export const COGNITIVE_LADDERS = {
  // Working memory: raise n first (1→2→3), then squeeze the presentation time
  // (2500→2000→1600ms) once 3-back is held — the two real difficulty levers.
  'n-back': {
    levels: [
      { n: 1, stimulusMs: 2500 },
      { n: 2, stimulusMs: 2500 },
      { n: 3, stimulusMs: 2500 },
      { n: 3, stimulusMs: 2000 },
      { n: 3, stimulusMs: 1600 },
    ],
    describe: rung => `${rung.n}-back @ ${rung.stimulusMs}ms`,
  },
  // Working memory span: grow the length window (4→9), forward first, then the
  // harder backward recall.
  'digit-span': {
    levels: [
      { direction: 'forward', startLength: 4, maxLength: 6 },
      { direction: 'forward', startLength: 5, maxLength: 7 },
      { direction: 'forward', startLength: 6, maxLength: 8 },
      { direction: 'backward', startLength: 4, maxLength: 6 },
      { direction: 'backward', startLength: 5, maxLength: 7 },
      { direction: 'backward', startLength: 6, maxLength: 9 },
    ],
    describe: rung => `${rung.direction} ${rung.startLength}–${rung.maxLength}`,
  },
  // Visual attention: bigger grid = more to scan (4×4 → 6×6).
  'schulte-table': {
    levels: [
      { size: 4 },
      { size: 5 },
      { size: 6 },
    ],
    describe: rung => `${rung.size}×${rung.size}`,
  },
  // Spatial reasoning: more trials per run (time pressure via volume).
  'mental-rotation': {
    levels: [
      { count: 6 },
      { count: 8 },
      { count: 10 },
      { count: 12 },
    ],
    describe: rung => `${rung.count} trials`,
  },
  // Attention/inhibition: more trials per run.
  'stroop': {
    levels: [
      { count: 10 },
      { count: 15 },
      { count: 20 },
      { count: 25 },
    ],
    describe: rung => `${rung.count} trials`,
  },
};

// Laddered cognitive drill types (drives getCognitiveProgress + the config UI).
export const COGNITIVE_LADDER_TYPES = Object.keys(COGNITIVE_LADDERS);

// Memoized per-type progression resolvers (createProgression is cheap but the
// ladder shape is fixed, so build once).
const cognitiveProgressions = {};

export function cognitiveProgression(type) {
  const ladder = COGNITIVE_LADDERS[type];
  if (!ladder) return null;
  if (!cognitiveProgressions[type]) {
    cognitiveProgressions[type] = createProgression({
      levels: ladder.levels,
      describeLevel: level => ladder.describe(ladder.levels[level]),
      mastery: COGNITIVE_MASTERY_DEFAULTS,
      // No speedTargetForLevel → accuracy-only mastery.
    });
  }
  return cognitiveProgressions[type];
}

export function cognitiveLadder(type) {
  return COGNITIVE_LADDERS[type] || null;
}

/**
 * The generator-config knobs for a cognitive rung (clamped into range), spread
 * into the requested config at generation time. `{}` for a non-laddered type.
 */
export function cognitiveLevelConfig(type, level) {
  const prog = cognitiveProgression(type);
  if (!prog) return {};
  const idx = prog.clampLevel(level);
  return { ...COGNITIVE_LADDERS[type].levels[idx] };
}

/**
 * Resolve a cognitive drill's progressive difficulty from per-level stats.
 * Returns the generic resolveLevel explainer plus `type`, the resolved rung's
 * generator `config`, and the window/threshold metadata the badge shows.
 * `null` for a non-laddered type.
 */
export function resolveCognitiveProgression(type, levelStats = {}, floorLevel = 0) {
  const prog = cognitiveProgression(type);
  if (!prog) return null;
  const res = prog.resolveLevel(levelStats, {}, floorLevel);
  return {
    ...res,
    type,
    config: cognitiveLevelConfig(type, res.level),
    windowDays: COGNITIVE_MASTERY_DEFAULTS.windowDays,
    thresholds: {
      minSamples: COGNITIVE_MASTERY_DEFAULTS.minSamples,
      targetAccuracy: COGNITIVE_MASTERY_DEFAULTS.targetAccuracy,
    },
  };
}
