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
 * purely samples + accuracy. Cognitive ladders opt into the speed gate only
 * where response latency is part of the trained skill (Schulte and Stroop).
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
    const timedSamples = Number.isFinite(stat?.timedSamples) ? stat.timedSamples : avgResponseMs > 0 ? samples : 0;
    if (samples < options.minSamples) return false;
    if (accuracy < options.targetAccuracy) return false;
    const target = speedTargetForLevel ? speedTargetForLevel(clamp(level), options) : null;
    if (target != null && Number.isFinite(target) && target > 0) {
      // avgResponseMs of 0 means no timed samples — never "instant mastery".
      if (timedSamples < options.minSamples) return false;
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
      const attempts = Number.isFinite(stat.attempts) ? stat.attempts : samples;
      const accuracy = Number.isFinite(stat.accuracy) ? stat.accuracy : 0;
      const completion = Number.isFinite(stat.completion) ? stat.completion : 0;
      const incompleteSamples = Number.isFinite(stat.incompleteSamples) ? stat.incompleteSamples : 0;
      const avgResponseMs = Number.isFinite(stat.avgResponseMs) ? stat.avgResponseMs : 0;
      const timedSamples = Number.isFinite(stat.timedSamples) ? stat.timedSamples : avgResponseMs > 0 ? samples : 0;
      const targetMs = speedTargetForLevel ? speedTargetForLevel(level, options) : null;
      return {
        level,
        descriptor,
        label: def.describeLevel(level),
        samples,
        attempts,
        accuracy,
        completion,
        incompleteSamples,
        avgResponseMs,
        timedSamples,
        targetMs,
        mastered: isLevelMastered({ samples, accuracy, avgResponseMs, timedSamples }, level, options),
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
// meatspacePostAdaptive.js resolveDrillConfig), so climbing the ladder makes
// the generated drill harder. `describe` turns a rung into a short label for
// the config/preview badge. reaction-time is deliberately absent — it's a
// measurement baseline, not a skill ladder.
//
// Mastery always uses exact-rung samples + accuracy + completion-qualified
// runs. Schulte and Stroop additionally gate on average response latency because
// speed/response pressure is part of those skills; the other ladders deliberately
// remain accuracy-only. For n-back the accuracy stamped per task is the balanced
// signal-detection accuracy from #2094, so the do-nothing exploit can't bank a
// rung.

export const COGNITIVE_MASTERY_DEFAULTS = {
  // A "sample" here is one completed drill at a level (not one answered
  // question), so a handful of clean runs is enough to advance.
  minSamples: 3,
  targetAccuracy: 0.85,
  // A run must reach at least this fraction of its trials to count toward
  // mastery. Accuracy is answered-only, so without this a digit-span run that
  // answers just the one easy sequence and leaves the hard ones blank banks a
  // 100%-accuracy "sample" — skipped trials could otherwise promote the rung.
  // (n-back completion is always 1 — go/no-go — so this never gates it.)
  minCompletion: 0.75,
  windowDays: 30,
  responseMsCap: 120000,
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
    speedTargetsMs: [2500, 3000, 3500],
  },
  // Spatial reasoning: add transformation range and mirrored visual competition.
  // Run length may rise too, but it is never the sole difficulty change.
  'mental-rotation': {
    levels: [
      { count: 6, rotationComplexity: 1, optionCount: 2 },
      { count: 6, rotationComplexity: 2, optionCount: 3 },
      { count: 8, rotationComplexity: 3, optionCount: 3 },
      { count: 8, rotationComplexity: 3, optionCount: 4 },
    ],
    describe: rung => `${rung.rotationComplexity === 1 ? '90°' : rung.rotationComplexity === 2 ? '90–180°' : 'any rotation'} · ${rung.optionCount} options`,
  },
  // Attention/inhibition: raise the proportion of conflicting word/ink trials.
  // Count can vary for evidence volume, but conflict is the real rung lever.
  'stroop': {
    levels: [
      { count: 10, incongruentPct: 50 },
      { count: 12, incongruentPct: 65 },
      { count: 15, incongruentPct: 80 },
      { count: 18, incongruentPct: 90 },
    ],
    describe: rung => `${rung.incongruentPct}% conflict · ${rung.count} trials`,
    speedTargetsMs: [1500, 1400, 1300, 1200],
  },
  // Executive rule switching: add a third rule, increase the proportion of
  // switches/conflicting attributes, shorten the cue lead, and tighten the
  // response window. Every rung changes at least two demand levers.
  'task-switching': {
    levels: [
      { ruleCount: 2, switchRatePct: 25, cueStimulusIntervalMs: 900, incongruentPct: 30, responseDeadlineMs: 2500 },
      { ruleCount: 2, switchRatePct: 50, cueStimulusIntervalMs: 700, incongruentPct: 50, responseDeadlineMs: 2200 },
      { ruleCount: 3, switchRatePct: 45, cueStimulusIntervalMs: 550, incongruentPct: 65, responseDeadlineMs: 1900 },
      { ruleCount: 3, switchRatePct: 65, cueStimulusIntervalMs: 350, incongruentPct: 80, responseDeadlineMs: 1600 },
    ],
    describe: rung => `${rung.ruleCount} rules · ${rung.switchRatePct}% switches · ${rung.incongruentPct}% conflict`,
    speedTargetsMs: [1800, 1600, 1450, 1250],
  },
  // Response inhibition: no-go events become more frequent, the display and
  // deadline tighten, then lure similarity increases.
  'go-no-go': {
    levels: [
      { noGoPct: 20, stimulusMs: 750, lureSimilarity: 'low', responseDeadlineMs: 1600 },
      { noGoPct: 30, stimulusMs: 600, lureSimilarity: 'low', responseDeadlineMs: 1400 },
      { noGoPct: 35, stimulusMs: 475, lureSimilarity: 'high', responseDeadlineMs: 1200 },
      { noGoPct: 40, stimulusMs: 350, lureSimilarity: 'high', responseDeadlineMs: 950 },
    ],
    describe: rung => `${rung.noGoPct}% no-go · ${rung.lureSimilarity} similarity · ${rung.responseDeadlineMs}ms`,
  },
  // Flanker interference: reduce the easy congruent share, bring distractors
  // closer, strengthen them, and tighten the response window.
  'flanker': {
    levels: [
      { congruentPct: 75, flankerDistance: 4, flankerStrength: 1, responseDeadlineMs: 1900 },
      { congruentPct: 60, flankerDistance: 3, flankerStrength: 2, responseDeadlineMs: 1650 },
      { congruentPct: 50, flankerDistance: 2, flankerStrength: 2, responseDeadlineMs: 1400 },
      { congruentPct: 40, flankerDistance: 1, flankerStrength: 3, responseDeadlineMs: 1150 },
    ],
    describe: rung => `${100 - rung.congruentPct}% conflict · distance ${rung.flankerDistance} · strength ${rung.flankerStrength}`,
    speedTargetsMs: [1400, 1250, 1100, 950],
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
      ...(Array.isArray(ladder.speedTargetsMs) && {
        speedTargetForLevel: level => ladder.speedTargetsMs[level],
      }),
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
  const levels = res.levels.map(rung => ({
    ...rung,
    criteria: {
      samples: {
        actual: rung.samples,
        target: COGNITIVE_MASTERY_DEFAULTS.minSamples,
        met: rung.samples >= COGNITIVE_MASTERY_DEFAULTS.minSamples,
      },
      accuracy: {
        actual: rung.accuracy,
        target: COGNITIVE_MASTERY_DEFAULTS.targetAccuracy,
        met: rung.accuracy >= COGNITIVE_MASTERY_DEFAULTS.targetAccuracy,
      },
      completion: {
        actual: rung.completion,
        target: COGNITIVE_MASTERY_DEFAULTS.minCompletion,
        excluded: rung.incompleteSamples,
      },
      speed: rung.targetMs == null ? null : {
        actualMs: rung.avgResponseMs,
        targetMs: rung.targetMs,
        timedSamples: rung.timedSamples,
        met: rung.timedSamples >= COGNITIVE_MASTERY_DEFAULTS.minSamples
          && rung.avgResponseMs > 0
          && rung.avgResponseMs <= rung.targetMs,
      },
    },
  }));
  const current = levels[res.level];
  const reasons = [];
  if (current.samples < COGNITIVE_MASTERY_DEFAULTS.minSamples) reasons.push('samples');
  if (current.accuracy < COGNITIVE_MASTERY_DEFAULTS.targetAccuracy) reasons.push('accuracy');
  if (current.targetMs != null && !current.criteria.speed.met) reasons.push('speed');
  return {
    ...res,
    levels,
    type,
    config: cognitiveLevelConfig(type, res.level),
    windowDays: COGNITIVE_MASTERY_DEFAULTS.windowDays,
    decision: {
      action: res.level > res.floorLevel ? 'promote' : res.atHardest && res.currentMastered ? 'mastered' : 'hold',
      reasons,
    },
    thresholds: {
      minSamples: COGNITIVE_MASTERY_DEFAULTS.minSamples,
      targetAccuracy: COGNITIVE_MASTERY_DEFAULTS.targetAccuracy,
      minCompletion: COGNITIVE_MASTERY_DEFAULTS.minCompletion,
    },
  };
}
