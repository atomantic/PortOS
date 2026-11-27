// Scores foundation dimensions, validates judge output and checks verdict staleness.

import { SERIES_AUTOPILOT_DEFAULTS } from '../../lib/seriesAutopilotDefaults.js';
import { trimTo } from '../../lib/textUtils.js';

// The four rubric dimensions and their weights — the single source of truth for
// the weighted composite, the fix router, sanitize, and client rendering.
// Order is display order. Weights sum to 1.0 (asserted at module load).
export const FOUNDATION_DIMENSIONS = Object.freeze(['worldbuilding', 'character', 'structure', 'craft']);

export const FOUNDATION_WEIGHTS = Object.freeze({
  worldbuilding: 0.4,
  character: 0.3,
  structure: 0.2,
  craft: 0.1,
});
// Fail fast if a future edit unbalances the rubric — a weighted score is only
// meaningful when the weights sum to 1.
const WEIGHT_SUM = FOUNDATION_DIMENSIONS.reduce((n, d) => n + FOUNDATION_WEIGHTS[d], 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(`foundationJudge: FOUNDATION_WEIGHTS must sum to 1 (got ${WEIGHT_SUM})`);
}

// Default gate threshold — the weighted [0,10] score the foundation must clear
// before drafting. Mirrors autonovel's 7.5 foundation bar (design record
// Phase 11). Overridable per-run + via the persisted setting.
export const DEFAULT_FOUNDATION_THRESHOLD = SERIES_AUTOPILOT_DEFAULTS.foundationThreshold;
// A strong weighted world score must not hide a critically thin character or
// craft foundation. The floor follows an intentionally lowered run threshold,
// but otherwise keeps every dimension at a publishable planning baseline.
export const DEFAULT_FOUNDATION_DIMENSION_FLOOR = 6;

// Defensive caps on LLM output — never trust raw model JSON.
const GAP_MAX = 600;
const FIX_MAX = 600;
const SUMMARY_MAX = 600;

// ---------- weighted composite math ----------

const clampScore = (v, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, Math.round(n * 100) / 100));
};

/**
 * The weighted [0,10] composite — Σ dimension.score × weight. A missing/invalid
 * dimension contributes 0 for its term (never NaN-poisons the score). Pure +
 * unit-tested; the autopilot gate compares this against the threshold.
 */
export function computeWeightedScore(dimensions) {
  const dims = dimensions && typeof dimensions === 'object' ? dimensions : {};
  let total = 0;
  for (const d of FOUNDATION_DIMENSIONS) {
    const score = Number(dims[d]?.score);
    total += (Number.isFinite(score) ? score : 0) * FOUNDATION_WEIGHTS[d];
  }
  return Math.round(total * 100) / 100;
}

/**
 * Largest weighted distance from a perfect rubric score, retained for snapshot
 * diagnostics: `weight × (10 − score)`. Gate repair selection instead uses
 * foundationFixTarget with the requested threshold. Ties break toward the lower raw score, then rubric order.
 * (Fixing a high-weight low-score dimension first is what converges the gate;
 * "weakest" by bare score would waste rounds polishing a 10%-weight craft nit
 * while a thin 40%-weight world drags the composite down.) Pure + unit-tested.
 * Returns `{ dimension, score, deficit }`, or null when no dimension is present.
 */
export function weakestDimension(dimensions) {
  const dims = dimensions && typeof dimensions === 'object' ? dimensions : {};
  let best = null;
  for (const d of FOUNDATION_DIMENSIONS) {
    if (!dims[d]) continue;
    const score = clampScore(dims[d].score);
    const deficit = Math.round(FOUNDATION_WEIGHTS[d] * (10 - score) * 100) / 100;
    if (
      best === null
      || deficit > best.deficit
      || (deficit === best.deficit && score < best.score)
    ) {
      best = { dimension: d, score, deficit };
    }
  }
  return best;
}

export function foundationGateStatus(dimensions, weightedScore, threshold = DEFAULT_FOUNDATION_THRESHOLD) {
  const dimensionFloor = Math.min(
    Number.isFinite(threshold) ? threshold : DEFAULT_FOUNDATION_THRESHOLD,
    DEFAULT_FOUNDATION_DIMENSION_FLOOR,
  );
  const failingDimensions = FOUNDATION_DIMENSIONS
    .filter((dimension) => clampScore(dimensions?.[dimension]?.score) < dimensionFloor);
  return {
    dimensionFloor,
    failingDimensions,
    passes: Number(weightedScore) >= threshold && failingDimensions.length === 0,
  };
}

export function foundationFixTarget(dimensions, threshold = DEFAULT_FOUNDATION_THRESHOLD) {
  const { dimensionFloor, failingDimensions } = foundationGateStatus(dimensions, 0, threshold);
  if (failingDimensions.length === 0) {
    const target = Number.isFinite(threshold) ? threshold : DEFAULT_FOUNDATION_THRESHOLD;
    // Repair the shortfall that keeps this run below its requested bar. Using
    // distance from 10 sent a 7.8/8 foundation back to worldbuilding (already 8)
    // while its only deficient dimension, structure (7), remained untouched.
    const belowTarget = FOUNDATION_DIMENSIONS
      .filter((dimension) => dimensions?.[dimension] && clampScore(dimensions[dimension].score) < target)
      .map((dimension) => ({
        dimension,
        score: clampScore(dimensions[dimension].score),
        deficit: Math.round(FOUNDATION_WEIGHTS[dimension] * (target - clampScore(dimensions[dimension].score)) * 100) / 100,
      }))
      .sort((a, b) => b.deficit - a.deficit || a.score - b.score
        || FOUNDATION_DIMENSIONS.indexOf(a.dimension) - FOUNDATION_DIMENSIONS.indexOf(b.dimension));
    return belowTarget[0] || weakestDimension(dimensions);
  }
  return failingDimensions
    .map((dimension) => ({
      dimension,
      score: clampScore(dimensions?.[dimension]?.score),
      deficit: Math.round((dimensionFloor - clampScore(dimensions?.[dimension]?.score)) * 100) / 100,
    }))
    .sort((a, b) => a.score - b.score
      || FOUNDATION_DIMENSIONS.indexOf(a.dimension) - FOUNDATION_DIMENSIONS.indexOf(b.dimension))[0];
}

// ---------- sanitize LLM output ----------

function sanitizeDimension(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    score: clampScore(d.score),
    gap: trimTo(d.gap, GAP_MAX),
    fix: trimTo(d.fix, FIX_MAX),
  };
}

const PLACEHOLDER_FINDING = /^(?:string|placeholder|todo|tbd|n\/?a|none|null|undefined)$/i;
const isMeaningfulFinding = (value) => (
  typeof value === 'string'
  && value.trim().length > 0
  && !PLACEHOLDER_FINDING.test(value.trim())
);

// A judge response is "valid-shaped" only when every rubric dimension contains
// a usable score plus concrete gap/fix prose. The prompt itself includes a JSON
// shape example whose values are `{ score: 6, gap: "string", fix: "string" }`;
// if a TUI screen scrape ever leaks through, a permissive dimensions-only check
// would mistake that echoed contract for a real verdict and spend a repair round
// on the literal instruction "string". Reject incomplete and placeholder
// rubrics so the deliberate retry (and ultimately the caller) handles them as
// malformed output instead of persisting fabricated editorial evidence.
export function isValidFoundationShape(content) {
  if (!(content && typeof content === 'object'
    && content.dimensions && typeof content.dimensions === 'object')) return false;
  if (!FOUNDATION_DIMENSIONS.every((dimension) => {
    const finding = content.dimensions[dimension];
    const score = Number(finding?.score);
    return finding && typeof finding === 'object'
      && Number.isFinite(score) && score >= 1 && score <= 10
      && isMeaningfulFinding(finding.gap)
      && isMeaningfulFinding(finding.fix);
  })) return false;
  return content.oneLineVerdict === undefined || isMeaningfulFinding(content.oneLineVerdict);
}

export function sanitizeFoundationJudge(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const rawDims = p.dimensions && typeof p.dimensions === 'object' ? p.dimensions : {};
  const dimensions = {};
  for (const key of FOUNDATION_DIMENSIONS) dimensions[key] = sanitizeDimension(rawDims[key]);
  return {
    dimensions,
    weightedScore: computeWeightedScore(dimensions),
    oneLineVerdict: trimTo(p.oneLineVerdict, SUMMARY_MAX),
  };
}

// The per-dimension findings carried into a pause's `residual` for human review
// — same `{ severity, location, problem, suggestion }` shape the arc/editorial
// gates use, so the existing pause UI renders foundation findings unchanged.
export function residualFindings(dimensions) {
  const dims = dimensions && typeof dimensions === 'object' ? dimensions : {};
  return FOUNDATION_DIMENSIONS
    .filter((d) => dims[d])
    .map((d) => ({
      severity: 'high',
      location: `${d} (weight ${Math.round(FOUNDATION_WEIGHTS[d] * 100)}%, scored ${clampScore(dims[d].score)})`,
      problem: dims[d].gap || `${d} is below the foundation-quality bar`,
      suggestion: dims[d].fix || '',
    }));
}

// Staleness: a complete snapshot is stale when the current foundation inputs no
// longer match the pinned hash (mirrors pipelineJudge.js). A legacy snapshot
// with no hash is treated as not-stale (can't tell).
export function isFoundationStale(snap, currentHash) {
  if (!snap || snap.status !== 'complete') return false;
  if (!snap.sourceInputsHash) return false;
  return snap.sourceInputsHash !== currentHash;
}
