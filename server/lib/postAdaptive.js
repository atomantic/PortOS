/**
 * POST adaptive difficulty policy (pure, side-effect-free).
 *
 * Given a math drill's base config and the user's recent performance signal
 * ({ score, samples }), nudge a single primary difficulty knob up or down within
 * clamped bounds. Opt-in: the caller only applies this when the user has enabled
 * the Adaptive toggle in POST config; when off, base config is the override.
 *
 * The signal is the average scored-session `score` (0-100) for the drill type
 * from `getPostStats().byDrill`, gated by `byDrillCount` samples so a single
 * lucky/unlucky run can't swing difficulty.
 */

// One primary difficulty knob per math drill type. `harderIsHigher` flips the
// direction for knobs where a LOWER value is harder (estimation tolerance).
// min/max stay within the ranges accepted by `drillTypeConfigSchema`.
export const ADAPTIVE_SPECS = {
  'doubling-chain': { field: 'steps', base: 8, min: 4, max: 16, step: 2, harderIsHigher: true },
  'serial-subtraction': { field: 'steps', base: 10, min: 5, max: 20, step: 2, harderIsHigher: true },
  'multiplication': { field: 'maxDigits', base: 2, min: 1, max: 4, step: 1, harderIsHigher: true },
  'powers': { field: 'maxExponent', base: 10, min: 4, max: 16, step: 2, harderIsHigher: true },
  'estimation': { field: 'tolerancePct', base: 10, min: 3, max: 20, step: 3, harderIsHigher: false },
};

export const ADAPTIVE_DEFAULTS = {
  highScore: 90, // >= this ACCURACY (0-100, answered-only) over enough samples → harder
  lowScore: 50, // <= this → ease difficulty down one step
  minSamples: 3, // need at least this many scored samples before adapting
  minCompletion: 0.5, // skip adaptation when avg completion < this — too little signal
  windowDays: 30, // stats window the signal is read over
};

export function clampNum(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Map a recent score to a difficulty direction.
 * @returns {number} 1 = harder, -1 = easier, 0 = hold
 */
export function scoreToDirection(score, { highScore, lowScore } = ADAPTIVE_DEFAULTS) {
  if (score == null || Number.isNaN(score)) return 0;
  if (score >= highScore) return 1;
  if (score <= lowScore) return -1;
  return 0;
}

/**
 * Compute an adapted drill config plus a transparent explanation.
 *
 * @param {string} type - math drill type
 * @param {object} baseConfig - the user's configured drill params
 * @param {{score?: number|null, samples?: number, completion?: number|null}} signal - recent performance
 * @param {object} [opts] - override ADAPTIVE_DEFAULTS thresholds
 * @returns {{config: object, type, field, from, to, direction, applied, score, samples, completion, reason}}
 */
export function adaptDrillConfig(type, baseConfig = {}, signal = {}, opts = {}) {
  const spec = ADAPTIVE_SPECS[type];
  const options = { ...ADAPTIVE_DEFAULTS, ...opts };
  const base = { ...(baseConfig || {}) };
  const samples = Number.isFinite(signal?.samples) ? signal.samples : 0;
  const score = signal?.score == null || Number.isNaN(signal.score) ? null : signal.score;
  const completion = signal?.completion == null || Number.isNaN(signal.completion) ? null : signal.completion;

  const out = {
    config: base,
    type,
    field: spec?.field ?? null,
    from: null,
    to: null,
    direction: 0,
    applied: false,
    score,
    samples,
    completion,
    reason: 'unsupported',
  };

  if (!spec) return out;

  const currentRaw = Number.isFinite(base[spec.field]) ? base[spec.field] : spec.base;
  const current = clampNum(currentRaw, spec.min, spec.max);
  out.from = current;
  out.to = current;

  if (samples < options.minSamples) {
    // Adaptive not engaged yet — leave the manual config untouched (the manual
    // value stays the override until there's enough signal to manage difficulty).
    out.reason = 'insufficient-samples';
    return out;
  }

  if (completion != null && completion < options.minCompletion) {
    // The user barely reached this drill (timed out on most of it) — accuracy off
    // a handful of answers isn't a trustworthy difficulty signal, so hold the
    // manual config until they complete more of it (issue #2094).
    out.reason = 'insufficient-completion';
    return out;
  }

  const direction = scoreToDirection(score, options);
  out.direction = direction;

  const valueDelta = direction * spec.step * (spec.harderIsHigher ? 1 : -1);
  const next = clampNum(current + valueDelta, spec.min, spec.max);
  out.to = next;

  // Once adaptive is engaged, ALWAYS write the adaptive-clamped value into the
  // effective config — even on the hold/at-boundary paths where `next === current`.
  // Otherwise a manual config the schema allows but the adaptive spec caps lower
  // (e.g. steps=20 vs adaptive max 16) would be reported as clamped in the preview
  // but still generated at the raw value, breaking the advertised bounds.
  out.config = { ...base, [spec.field]: next };

  if (direction === 0) {
    out.reason = 'hold';
  } else if (next === current) {
    // Already at the difficulty boundary in the requested direction.
    out.reason = direction > 0 ? 'at-hardest' : 'at-easiest';
  } else {
    out.applied = true;
    out.reason = direction > 0 ? 'harder' : 'easier';
  }
  return out;
}
