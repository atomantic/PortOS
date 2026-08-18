/**
 * Local-model assessment scoring — pure, dependency-free.
 *
 * PortOS already guesses whether a local model fits from catalog metadata alone
 * (weight bytes × a fixed overhead multiplier, in `huggingFaceCatalog.js`). That
 * guess never touches the machine: it can't tell a model that loads and streams
 * fast from one that loads, thrashes, and crawls, and it says
 * nothing at all about how a model behaves as the prompt gets long.
 *
 * This module turns *measured* evidence — one bounded generation per context
 * length, recorded by `services/localModelAssessments.js` — into an explainable
 * verdict and an intent-specific ranking.
 *
 * ## The sentinel contract (read before touching anything here)
 *
 * `null` means NOT MEASURED. It never means zero, never means failed, and never
 * collapses into a fallback. `[]` / `0` mean measured-and-empty. Concretely:
 *
 *   - `sample.charsPerSecond === null`  → the sample never produced timings
 *   - `sample.ok === false`              → the sample RAN and FAILED (has `error`)
 *   - `verdict === 'unknown'`            → nothing usable was measured
 *   - `scores.speed === null`            → speed was never observed; a ranking
 *                                          must not treat that as "slow"
 *
 * Anything that conflates those makes an unassessed model look worse than a
 * measured-bad one, which is the exact failure this feature exists to remove.
 */

/**
 * Fit verdicts. Deliberately four values, not a boolean:
 *   - `fits`         — at least one context length generated successfully
 *   - `does-not-fit` — every attempted context length failed for a resource
 *                      reason (OOM / load failure / timeout)
 *   - `incompatible` — the backend refused the model outright (wrong format,
 *                      unsupported architecture) — retrying with less context
 *                      or more RAM will not help
 *   - `unknown`      — nothing was measured
 */
export const FIT_VERDICTS = ['fits', 'does-not-fit', 'incompatible', 'unknown'];

/** Ranking intents, mirroring how people actually pick a local model. */
export const ASSESSMENT_INTENTS = ['balanced', 'smartest', 'fastest', 'lightweight'];

// Error text that means "this model can never run here", as opposed to "this
// model ran out of room at this context length". Matched case-insensitively
// against the sample error. Kept narrow on purpose: a false `incompatible`
// permanently hides a model that a smaller context would have run.
const INCOMPATIBLE_RE =
  /unsupported|unknown model architecture|unrecognized|not supported|invalid model file|no such file|unsupported model format|does not support/i;

// Error text that means "resource exhaustion at this size" — the model itself is
// fine, this machine could not hold it as configured.
const RESOURCE_RE =
  /out of memory|oom|cannot allocate|insufficient memory|not enough memory|resource exhausted|model requires more system memory|timed out|context (?:length|window) exceed/i;

/**
 * Classify one recorded sample's failure. Returns `null` for a sample that
 * succeeded or that carries no error text (unknown cause — never guessed at).
 *
 * @param {{ ok?: boolean, error?: string }} sample
 * @returns {'incompatible'|'resource'|null}
 */
export function classifySampleFailure(sample) {
  if (!sample || sample.ok !== false) return null;
  const error = typeof sample.error === 'string' ? sample.error : '';
  if (!error) return null;
  if (INCOMPATIBLE_RE.test(error)) return 'incompatible';
  if (RESOURCE_RE.test(error)) return 'resource';
  return null;
}

const isMeasured = (value) => typeof value === 'number' && Number.isFinite(value);

/** Samples that actually produced output. */
const okSamples = (samples) => (Array.isArray(samples) ? samples : []).filter((s) => s?.ok === true);

/**
 * Derive the fit verdict from the recorded samples.
 *
 * One success anywhere is enough for `fits` — a model that runs at 4k but dies
 * at 32k still fits this machine, and `maxWorkingContextTokens` (below) is what
 * carries the nuance. `incompatible` wins over `does-not-fit` because it is the
 * actionable one: no amount of freed memory changes it.
 *
 * @param {Array<{ ok?: boolean, error?: string }>} samples
 * @returns {'fits'|'does-not-fit'|'incompatible'|'unknown'}
 */
export function classifyFitVerdict(samples) {
  const list = Array.isArray(samples) ? samples : [];
  if (list.length === 0) return 'unknown';
  if (list.some((s) => s?.ok === true)) return 'fits';
  const failures = list.map(classifySampleFailure);
  if (failures.some((f) => f === 'incompatible')) return 'incompatible';
  if (failures.some((f) => f === 'resource')) return 'does-not-fit';
  // Ran, failed, and we can't say why (network blip, backend restart). That is
  // NOT evidence the model doesn't fit — leave it unknown so a re-run decides.
  return 'unknown';
}

/**
 * Largest context length that produced a successful generation.
 * `null` when nothing succeeded — distinct from `0`, which never occurs here.
 *
 * @param {Array<{ ok?: boolean, contextTokens?: number }>} samples
 * @returns {number|null}
 */
export function maxWorkingContextTokens(samples) {
  const working = okSamples(samples)
    .map((s) => s.contextTokens)
    .filter(isMeasured);
  return working.length ? Math.max(...working) : null;
}

/**
 * Mean of a numeric field across successful samples, or `null` when the field
 * was never measured. Rounded to two decimals so persisted records stay stable.
 */
function meanOf(samples, field) {
  const values = okSamples(samples).map((s) => s[field]).filter(isMeasured);
  if (!values.length) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Number(mean.toFixed(2));
}

/**
 * Collapse the per-context samples into one performance summary.
 *
 * `contextDegradation` is the ratio of the throughput at the LARGEST working
 * context to the peak throughput across all contexts (0..1]; 1 means the longest
 * context ran as fast as the fastest one did, 0.25 means it ran at a quarter of
 * that.
 *
 * It is deliberately anchored to the longest context rather than to the slowest
 * sample. Results are not always monotonic — a mid-range context can dip below
 * both its neighbours from an unrelated hiccup — and a min-based ratio would
 * both contradict what this number is reported as ("held X% of peak throughput
 * at its longest context") and penalize the ranking for a one-off intermediate
 * outlier instead of for the long-context behavior the axis is about.
 *
 * `null` when fewer than two context lengths produced throughput: a single
 * sample cannot describe a trend, and reporting `1` there would fake perfect
 * scaling.
 *
 * @param {Array<object>} samples
 */
export function summarizePerformance(samples) {
  const measured = okSamples(samples)
    .filter((s) => isMeasured(s.charsPerSecond) && s.charsPerSecond > 0 && isMeasured(s.contextTokens));
  const fastest = measured.length ? Math.max(...measured.map((s) => s.charsPerSecond)) : null;
  const atLongest = measured.length
    ? measured.reduce((longest, s) => (s.contextTokens > longest.contextTokens ? s : longest)).charsPerSecond
    : null;
  return {
    samplesRun: Array.isArray(samples) ? samples.length : 0,
    samplesOk: okSamples(samples).length,
    meanCharsPerSecond: meanOf(samples, 'charsPerSecond'),
    meanTtftMs: meanOf(samples, 'ttftMs'),
    peakCharsPerSecond: fastest,
    maxWorkingContextTokens: maxWorkingContextTokens(samples),
    // Clamped: the longest context can measure marginally ABOVE the peak of the
    // others only through noise, and a >1 "degradation" is meaningless.
    contextDegradation:
      measured.length >= 2 && fastest > 0 ? Number(Math.min(1, atLongest / fastest).toFixed(3)) : null,
  };
}

// Speed normalization anchor, in CHARACTERS per second — the unit PortOS
// actually measures (`localLlmPlayground.summarizeTimings`). There is no
// tokenizer anywhere in the repo, so reporting a tokens/sec figure would be an
// invented number dressed as a measurement. 240 chars/s (~60 tok/s at the
// conventional ~4 chars/token) is a comfortable interactive rate on consumer
// hardware; at or above it the axis scores 1, below it the score is linear so a
// crawling model reads as clearly worse rather than both bottoming out.
const SPEED_CEILING_CHARS_PER_SECOND = 240;

// Parameter-count anchor for the capability score. Local models above ~70B are
// rare on consumer hardware and already score at the top of the curve.
const PARAMS_CEILING_B = 70;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Parse a parameter count in billions out of a params string or model id
 * (`"32B"`, `"qwen3:14b"`). `null` when the id carries no size marker — never
 * defaulted, so an unsized model doesn't masquerade as a small one.
 *
 * @param {{ params?: string, modelId?: string }} model
 * @returns {number|null}
 */
export function parseParamsBillions({ params, modelId } = {}) {
  const match = `${params || ''} ${modelId || ''}`.match(/(\d+(?:\.\d+)?)\s*[bB]\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Score one assessment on the four axes the ranking uses. Every axis is `null`
 * when its evidence is missing — callers must handle that rather than
 * substituting 0.
 *
 * - `capability` — parameter count, the only capability proxy available offline
 * - `speed`      — measured mean throughput against the interactive anchor
 * - `fidelity`   — how well throughput held up as context grew (needs ≥2 samples)
 * - `memory`     — measured headroom left after the model's resident footprint
 *
 * @param {object} assessment
 * @returns {{capability:number|null, speed:number|null, fidelity:number|null, memory:number|null}}
 */
export function scoreAssessment(assessment) {
  const perf = assessment?.performance || {};
  const paramsB = parseParamsBillions({ params: assessment?.params, modelId: assessment?.modelId });
  const residentGb = assessment?.residentGb;
  const budgetGb = assessment?.environment?.memoryBudgetGb;

  const memory =
    isMeasured(residentGb) && isMeasured(budgetGb) && budgetGb > 0
      ? clamp01(1 - residentGb / budgetGb)
      : null;

  return {
    capability: paramsB == null ? null : clamp01(Math.log10(1 + paramsB) / Math.log10(1 + PARAMS_CEILING_B)),
    speed: isMeasured(perf.meanCharsPerSecond) ? clamp01(perf.meanCharsPerSecond / SPEED_CEILING_CHARS_PER_SECOND) : null,
    fidelity: isMeasured(perf.contextDegradation) ? clamp01(perf.contextDegradation) : null,
    memory,
  };
}

// Per-intent axis weights. Weights of axes with no measurement are dropped and
// the rest renormalized, so a partly-measured model is scored on what IS known
// instead of being penalized for the gap. `coverage` reports how much of the
// intended weight was actually backed by evidence, and the caller surfaces it.
const INTENT_WEIGHTS = {
  balanced: { capability: 0.3, speed: 0.3, fidelity: 0.2, memory: 0.2 },
  smartest: { capability: 0.6, speed: 0.1, fidelity: 0.2, memory: 0.1 },
  fastest: { capability: 0.1, speed: 0.6, fidelity: 0.2, memory: 0.1 },
  lightweight: { capability: 0.1, speed: 0.25, fidelity: 0.15, memory: 0.5 },
};

/**
 * Weighted score for one intent.
 *
 * @param {object} scores from `scoreAssessment`
 * @param {string} intent one of ASSESSMENT_INTENTS
 * @returns {{ score: number|null, coverage: number }} `score` is null when NO
 *   axis was measured — an unassessed model must not be rankable as "0".
 */
export function scoreForIntent(scores, intent) {
  const weights = INTENT_WEIGHTS[intent] || INTENT_WEIGHTS.balanced;
  let weighted = 0;
  let used = 0;
  for (const [axis, weight] of Object.entries(weights)) {
    const value = scores?.[axis];
    if (!isMeasured(value)) continue;
    weighted += value * weight;
    used += weight;
  }
  if (used === 0) return { score: null, coverage: 0 };
  return { score: Number((weighted / used).toFixed(4)), coverage: Number(used.toFixed(2)) };
}

const INTENT_LABEL = {
  balanced: 'balanced',
  smartest: 'strongest',
  fastest: 'fastest',
  lightweight: 'lightest',
};

/**
 * One-sentence, evidence-only explanation for a ranked candidate. Every clause
 * names a measured number; unmeasured axes are simply omitted rather than
 * described with a guess.
 */
export function explainAssessment(assessment, intent) {
  const perf = assessment?.performance || {};
  const parts = [];
  if (isMeasured(perf.meanCharsPerSecond)) parts.push(`${perf.meanCharsPerSecond} chars/s measured`);
  if (isMeasured(perf.maxWorkingContextTokens)) {
    parts.push(`ran at up to ${perf.maxWorkingContextTokens.toLocaleString('en-US')} tokens of context`);
  }
  if (isMeasured(perf.contextDegradation)) {
    parts.push(`held ${Math.round(perf.contextDegradation * 100)}% of peak throughput at its longest context`);
  }
  if (isMeasured(assessment?.residentGb)) parts.push(`${assessment.residentGb} GB resident`);
  if (!parts.length) return `No measurements recorded yet — run an assessment to rank it for ${INTENT_LABEL[intent] || intent} use.`;
  return `${parts.join(', ')}.`;
}

/**
 * Rank assessed models for one intent.
 *
 * Only `fits` candidates are ranked — a model that did not run is not a
 * recommendation, however good its metadata looks. Everything else is returned
 * under `excluded` with its verdict so the UI can explain the absence instead
 * of silently dropping it.
 *
 * @param {Array<object>} assessments
 * @param {string} intent
 * @returns {{ intent: string, ranked: Array<object>, excluded: Array<object> }}
 */
export function rankByIntent(assessments, intent = 'balanced') {
  const resolvedIntent = ASSESSMENT_INTENTS.includes(intent) ? intent : 'balanced';
  const list = Array.isArray(assessments) ? assessments : [];

  const ranked = [];
  const excluded = [];
  for (const assessment of list) {
    const verdict = assessment?.verdict || 'unknown';
    if (verdict !== 'fits') {
      excluded.push({
        backend: assessment?.backend || null,
        modelId: assessment?.modelId || null,
        verdict,
        reason: assessment?.verdictReason || null,
      });
      continue;
    }
    const scores = scoreAssessment(assessment);
    const { score, coverage } = scoreForIntent(scores, resolvedIntent);
    if (score == null) {
      excluded.push({
        backend: assessment?.backend || null,
        modelId: assessment?.modelId || null,
        verdict,
        reason: 'ran, but no axis of this intent was measured',
      });
      continue;
    }
    ranked.push({
      backend: assessment?.backend || null,
      modelId: assessment?.modelId || null,
      verdict,
      score,
      coverage,
      scores,
      performance: assessment?.performance || null,
      assessedAt: assessment?.assessedAt || null,
      explanation: explainAssessment(assessment, resolvedIntent),
    });
  }

  // Higher score first; ties broken by evidence coverage so a fully-measured
  // model outranks one scored on a single axis, then by model id for stability.
  ranked.sort((a, b) => (b.score - a.score) || (b.coverage - a.coverage) || String(a.modelId).localeCompare(String(b.modelId)));
  return { intent: resolvedIntent, ranked, excluded };
}
