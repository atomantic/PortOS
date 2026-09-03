/**
 * POST adaptive difficulty + progressive-ladder resolution.
 *
 * This is the POLICY layer above the two data layers: `meatspacePost.js` owns
 * raw sessions and per-ladder level history, `meatspacePostStats.js` owns the
 * derived aggregates, and this module turns both into the effective config a
 * drill is generated with (and the preview of that decision for the config UI).
 *
 * It lives here rather than inside `meatspacePost.js` because the adaptive
 * signal is read from `getPostStats()`, and `meatspacePostStats.js` reads raw
 * sessions back out of `meatspacePost.js` — computing the signal in the data
 * module closed a static ESM cycle whose only other purpose was letting callers
 * write `import { getPostStats } from './meatspacePost.js'` (issue #5690).
 */
import { adaptDrillConfig, ADAPTIVE_SPECS, ADAPTIVE_DEFAULTS } from '../lib/postAdaptive.js';
import { resolveMultiplicationLevel, MASTERY_DEFAULTS } from '../lib/postMultiplicationLadder.js';
import { POWERS_MASTERY_DEFAULTS, resolvePowersLevel } from '../lib/postPowersLadder.js';
import { cognitiveLadder, cognitiveLevelConfig, resolveCognitiveProgression } from '../lib/postProgression.js';
import {
  MATH_MODULE,
  getPostConfig,
  getMultiplicationProgress,
  getPowersProgress,
  getMultiplicationLevelStats,
  getPowersLevelStats,
  getCognitiveLevelStats,
} from './meatspacePost.js';
import { getPostStats } from './meatspacePostStats.js';

/**
 * Read the recent performance signal for one math drill type from scored
 * sessions. Returns { score, samples, completion } where `score` is now the avg
 * ACCURACY (0-100, answered-only) — not the blended session score — so a
 * fast-but-sloppy run and a slow-but-accurate run produce different adaptive
 * directions (issue #2094). `completion` (0-1) lets adaptDrillConfig skip
 * adaptation when the user barely reached the drill (too little signal).
 */
async function getAdaptiveSignal(type) {
  const stats = await getPostStats(ADAPTIVE_DEFAULTS.windowDays);
  const key = `${MATH_MODULE}:${type}`;
  const accuracy = stats.evidenceByDrillAccuracy?.[key];
  const samples = stats.evidenceByDrillCount?.[key] || 0;
  const completion = stats.evidenceByDrillCompletion?.[key];
  return {
    score: accuracy == null ? null : Math.round(accuracy * 100),
    samples,
    completion: completion == null ? null : completion,
  };
}

/**
 * Resolve the effective drill config for generation.
 *
 * - Multiplication with the progressive ladder ON (default): factor structure
 *   and difficulty come from mastery-gated level history, not the manual
 *   `maxDigits`. Returns a `progression` explainer.
 * - Adaptive toggle ON: math drill params are nudged from recent scored
 *   performance within clamped bounds. Returns an `adaptive` explainer.
 * - Otherwise (default): the caller's manual config passes through unchanged.
 *
 * @returns {{ config: object, adaptive: object|null, progression?: object|null }}
 */
export async function resolveDrillConfig(type, requestedConfig = {}) {
  const config = await getPostConfig();

  // Maintenance-review rep (issue #2096): a review rep targets a SPECIFIC lower
  // rung on purpose, so bypass the progression override entirely and run the
  // explicit level/factors the review scheduler chose. Without this the ladder
  // would silently re-resolve the level up to the user's current rung, defeating
  // the whole point of re-verifying a mastered-but-inactive skill.
  if (requestedConfig?.review) {
    return { config: requestedConfig, adaptive: null, progression: null };
  }

  // Progressive multiplication ladder (default ON) — independent of the generic
  // Adaptive toggle. Selects the factor structure by speed-gated mastery so a
  // fresh user starts at single-digit × single-digit instead of a fixed hard
  // difficulty. `maxDigits` is stripped so generation uses `factors`.
  if (type === 'multiplication') {
    const mulCfg = config?.mentalMath?.drillTypes?.multiplication || {};
    if (mulCfg.progressive !== false) {
      const { stats, floorLevel } = await getMultiplicationLevelStats(MASTERY_DEFAULTS.windowDays);
      const progression = resolveMultiplicationLevel(stats, {}, floorLevel);
      const { maxDigits: _drop, ...rest } = requestedConfig || {};
      const effective = {
        ...rest,
        count: rest.count ?? mulCfg.count ?? 10,
        level: progression.level,
        factors: progression.factors,
      };
      return { config: effective, adaptive: null, progression };
    }
  }

  if (type === 'powers') {
    const powersCfg = config?.mentalMath?.drillTypes?.powers || {};
    if (powersCfg.progressive !== false) {
      const { stats, floorLevel } = await getPowersLevelStats(POWERS_MASTERY_DEFAULTS.windowDays);
      const progression = resolvePowersLevel(stats, {}, floorLevel);
      const { bases: _bases, maxExponent: _maxExponent, ...rest } = requestedConfig || {};
      return {
        config: {
          ...rest,
          count: rest.count ?? powersCfg.count ?? 8,
          level: progression.level,
          technique: progression.technique,
        },
        adaptive: null,
        progression,
      };
    }
  }

  // Progressive cognitive ladders (default ON) — per-skill difficulty rungs
  // (n-back n/stimulusMs, digit-span span/direction, schulte grid, mental-
  // rotation transformation/options, Stroop interference mix). Selects the
  // rung by exact-level completion + accuracy, with speed gates where latency
  // is part of the skill; when off, the caller's manual knobs
  // (incl. stimulusMs/showMs) pass through unchanged. reaction-time has no
  // ladder and always passes through (issue #2095).
  if (cognitiveLadder(type)) {
    const cogCfg = config?.cognitive?.drillTypes?.[type] || {};
    if (cogCfg.progressive !== false) {
      const { stats, floorLevel } = await getCognitiveLevelStats(type);
      const progression = resolveCognitiveProgression(type, stats, floorLevel);
      const effective = {
        ...requestedConfig,
        ...cognitiveLevelConfig(type, progression.level),
        level: progression.level,
      };
      return { config: effective, adaptive: null, progression };
    }
    return { config: requestedConfig, adaptive: null };
  }

  if (!config?.adaptive?.enabled || !ADAPTIVE_SPECS[type]) {
    return { config: requestedConfig, adaptive: null };
  }
  const signal = await getAdaptiveSignal(type);
  const result = adaptDrillConfig(type, requestedConfig, signal);
  return { config: result.config, adaptive: result };
}

/**
 * Build a transparent per-type preview of the effective adaptive difficulty for
 * every supported math drill, so the config UI can show what Adaptive will do
 * before a session starts. `enabled` reflects the saved Adaptive toggle.
 *
 * Multiplication is a special case: `resolveDrillConfig` (above) hands
 * multiplication's difficulty entirely to the progressive ladder whenever
 * `progressive !== false` (the default) — the `maxDigits` Adaptive knob is
 * short-circuited and never applied in that mode. Previewing it via
 * `adaptDrillConfig` regardless would advertise a maxDigits adjustment that
 * can never actually happen (issue #2099). So this mirrors resolveDrillConfig's
 * own branch: ladder rung when progressive is on, the maxDigits Adaptive
 * preview only when the user has turned progressive off.
 */
export async function getAdaptivePreview() {
  const config = await getPostConfig();
  const enabled = !!config?.adaptive?.enabled;
  const stats = await getPostStats(ADAPTIVE_DEFAULTS.windowDays);
  const savedDrills = config?.mentalMath?.drillTypes || {};
  const multiplicationProgressive = savedDrills.multiplication?.progressive !== false;
  const powersProgressive = savedDrills.powers?.progressive !== false;

  const drills = {};
  for (const type of Object.keys(ADAPTIVE_SPECS)) {
    if (type === 'multiplication' && multiplicationProgressive) {
      // Same source of truth resolveDrillConfig uses for the ladder rung —
      // not the generic maxDigits Adaptive signal.
      drills[type] = { ladder: true, ...(await getMultiplicationProgress()) };
      continue;
    }
    if (type === 'powers' && powersProgressive) {
      drills[type] = { ladder: true, ...(await getPowersProgress()) };
      continue;
    }
    const key = `${MATH_MODULE}:${type}`;
    const accuracy = stats.byDrillAccuracy?.[key];
    const completion = stats.byDrillCompletion?.[key];
    const signal = {
      // Preview mirrors the live adaptive signal: accuracy (0-100), not the
      // blended score, plus completion for the low-completion skip (issue #2094).
      score: accuracy == null ? null : Math.round(accuracy * 100),
      samples: stats.byDrillCount?.[key] || 0,
      completion: completion == null ? null : completion,
    };
    // Base off the user's saved config so the preview matches what a session
    // would actually use; adaptDrillConfig falls back to the spec base per field.
    drills[type] = adaptDrillConfig(type, savedDrills[type] || {}, signal);
  }

  return { enabled, windowDays: ADAPTIVE_DEFAULTS.windowDays, thresholds: { highScore: ADAPTIVE_DEFAULTS.highScore, lowScore: ADAPTIVE_DEFAULTS.lowScore, minSamples: ADAPTIVE_DEFAULTS.minSamples, minCompletion: ADAPTIVE_DEFAULTS.minCompletion }, drills };
}
