// Pure planning helpers for the composed POST Quick session. Keeping the
// estimator and composer side-effect free makes the time-budget contract easy
// to test and keeps provider calls out of the planning path.

import { orderByRecencyRotation } from './postRotation.js';

export const QUICK_DURATION_MINUTES = [3, 5, 10, 15];
export const DEFAULT_QUICK_DURATION_MINUTES = 5;
export const QUICK_DURATION_TOLERANCE_SEC = 30;

const DEFAULT_ESTIMATE_SEC = {
  math: 45,
  cognitive: 45,
  memory: 40,
  llm: 60,
  review: 45,
};

const median = (values) => {
  const sorted = values
    .filter(value => Number.isFinite(value) && value > 0)
    .slice()
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Keep persisted or hand-edited preset values inside the supported choices. */
export function normalizeQuickDurationMinutes(value) {
  const numeric = Number(value);
  return QUICK_DURATION_MINUTES.includes(numeric)
    ? numeric
    : DEFAULT_QUICK_DURATION_MINUTES;
}

/**
 * Derive local observations from saved task durations. Three samples are the
 * minimum before a user's history can replace the stable new-install defaults.
 */
export function deriveQuickObservedDurations(sessions = []) {
  const byType = {};
  for (const session of sessions || []) {
    for (const task of session?.tasks || []) {
      const seconds = Number(task?.totalMs) / 1000;
      if (!task?.type || !Number.isFinite(seconds) || seconds <= 0) continue;
      (byType[task.type] ||= []).push(seconds);
    }
  }
  return byType;
}

/** Mirror the launcher's existing short-form config rules in one pure helper. */
export function buildQuickDrillConfig({ cfg = {}, source, memoryItemId } = {}) {
  if (source === 'math') {
    return {
      steps: cfg.steps,
      count: cfg.count ? Math.min(cfg.count, 5) : undefined,
      maxDigits: cfg.maxDigits,
      subtrahend: cfg.subtrahend,
      startRange: cfg.startRange,
      bases: cfg.bases,
      maxExponent: cfg.maxExponent,
      tolerancePct: cfg.tolerancePct,
      difficulty: cfg.difficulty,
      family: cfg.family,
    };
  }
  if (source === 'cognitive') {
    return {
      n: cfg.n,
      length: cfg.length,
      stimulusMs: cfg.stimulusMs,
      direction: cfg.direction,
      startLength: cfg.startLength,
      maxLength: cfg.maxLength,
      showMs: cfg.showMs,
      count: cfg.count ? Math.min(cfg.count, 10) : undefined,
      size: cfg.size,
      mode: cfg.mode,
      minDelayMs: cfg.minDelayMs,
      maxDelayMs: cfg.maxDelayMs,
      choices: cfg.choices,
    };
  }
  const count = Math.min(cfg.count || 5, 3);
  return source === 'memory'
    ? { count, memoryItemId }
    : { count };
}

function sourceForCandidate(candidate) {
  if (candidate?.kind === 'review') return 'review';
  return candidate?.source || 'math';
}

function defaultEstimateSec(candidate) {
  const source = sourceForCandidate(candidate);
  const config = candidate?.quickConfig || candidate?.config || {};
  const count = Number(config.count);
  if (source === 'math') {
    const steps = Number(config.steps);
    return Math.max(30, (Number.isFinite(count) ? count * 5 : 25) + (Number.isFinite(steps) ? steps * 2 : 10));
  }
  if (source === 'cognitive') {
    const length = Number(config.length);
    const maxLength = Number(config.maxLength);
    const size = Number(config.size);
    const trials = Number.isFinite(count)
      ? count
      : Number.isFinite(length)
        ? length
        : Number.isFinite(maxLength)
          ? maxLength
          : Number.isFinite(size)
            ? size * size
            : 10;
    return Math.max(30, Math.round(trials * (candidate?.type === 'reaction-time' ? 2 : 2.5)));
  }
  if (source === 'memory') return Math.max(30, (Number.isFinite(count) ? count : 3) * 12);
  if (source === 'llm') return Math.max(35, (Number.isFinite(count) ? count : 3) * 20);
  return DEFAULT_ESTIMATE_SEC[source] || DEFAULT_ESTIMATE_SEC.review;
}

/**
 * Estimate one candidate. Local medians are deliberately gated at three
 * observations, so a fresh install always has explicit deterministic defaults.
 */
export function estimateQuickDrillDurationSec(candidate, observedDurations = {}) {
  const observations = observedDurations?.[candidate?.type];
  const observed = Array.isArray(observations) && observations.length >= 3
    ? median(observations)
    : null;
  return Math.max(1, Math.round(observed ?? defaultEstimateSec(candidate)));
}

function inferSource(rep) {
  if (rep?.module === 'cognitive') return 'cognitive';
  if (rep?.module === 'llm-drills') return 'llm';
  if (rep?.module === 'memory') return 'memory';
  return 'math';
}

/**
 * Normalize the server's `recentPractice` payload into a membership test.
 * A memory drill's identity is its ITEM — practicing the Elements Song must not
 * make every other memory item look recently practiced (issue #5319) — while
 * every other drill is identified by its type.
 */
function recentPracticeMatcher({ drillTypes = [], memoryItemIds = [] } = {}) {
  const types = new Set(drillTypes);
  const items = new Set(memoryItemIds);
  return (candidate, memoryItemId) => (
    candidate?.source === 'memory' && memoryItemId
      ? items.has(memoryItemId)
      : types.has(candidate?.type)
  );
}

function candidateForDomain(domain, drills, recommendation, memoryItemIds = {}, { dayKey = null, isRecent = () => false } = {}) {
  const list = drills || [];
  if (!list.length) return null;
  const memoryItemIdFor = drill => drill.memoryItemId ?? memoryItemIds[drill.type];
  const recentDrill = drill => isRecent(drill, memoryItemIdFor(drill));
  const recommended = recommendation?.drillType
    ? list.find(drill => drill.type === recommendation.drillType)
    : null;
  // The recommendation wins its domain only while it is still fresh. Once it
  // has been practiced inside the window, this domain rotates to another
  // enabled candidate instead of re-serving registry-order `list[0]`.
  const pick = (recommended && !recentDrill(recommended))
    ? recommended
    : orderByRecencyRotation(list, { dayKey, isRecent: recentDrill })[0];
  const quickConfig = pick.quickConfig || buildQuickDrillConfig({
    ...pick,
    memoryItemId: memoryItemIdFor(pick),
  });
  return {
    kind: 'drill',
    domain,
    type: pick.type,
    cfg: pick.cfg,
    source: pick.source,
    quickConfig,
  };
}

function reviewCandidate(rep) {
  if (!rep?.type) return null;
  return {
    kind: 'review',
    domain: rep.domain || rep.domainKey,
    type: rep.type,
    config: rep.config || {},
    source: inferSource(rep),
    isReview: true,
    reviewLabel: rep.label,
    providerId: rep.providerId,
    model: rep.model,
  };
}

/**
 * Compose a stable Quick plan. A still-fresh top recommendation wins its
 * domain, due review reps come next, and remaining domains are then admitted
 * while the target+tolerance budget has room.
 *
 * `recentPractice` (from the recommendations endpoint: `{ dayKey, drillTypes,
 * memoryItemIds }`) is what keeps a multi-drill domain from serving the same
 * registry-order drill every day — within a domain, candidates practiced in the
 * window sink, and equally-eligible ones rotate by local day. Omitting it
 * restores the previous fixed ordering, so the plan is still deterministic when
 * the recommendations fetch fails.
 */
export function composeQuickSession({
  domainEntries = [],
  recommendation = null,
  reviewReps = [],
  durationMinutes = DEFAULT_QUICK_DURATION_MINUTES,
  toleranceSec = QUICK_DURATION_TOLERANCE_SEC,
  observedDurations = {},
  memoryItemIds = {},
  recentPractice = null,
} = {}) {
  const targetDurationSec = normalizeQuickDurationMinutes(durationMinutes) * 60;
  const budgetSec = targetDurationSec + Math.max(0, toleranceSec);
  const rotation = {
    dayKey: recentPractice?.dayKey || null,
    isRecent: recentPracticeMatcher(recentPractice || {}),
  };
  const domains = domainEntries
    .map(entry => ({
      domain: entry.domain,
      candidate: candidateForDomain(entry.domain, entry.drills, recommendation, memoryItemIds, rotation),
    }))
    .filter(entry => entry.candidate);

  const recommendationDomain = recommendation?.drillType
    ? domains.find(entry => entry.candidate.type === recommendation.drillType)?.domain
    : null;
  const recommendationCandidate = recommendationDomain
    ? domains.find(entry => entry.domain === recommendationDomain)?.candidate
    : null;
  const reviews = reviewReps.map(reviewCandidate).filter(Boolean).slice(0, 2);
  const occupiedReviewDomains = new Set(reviews.map(review => review.domain).filter(Boolean));
  const otherDomains = domains
    .filter(entry => entry.candidate !== recommendationCandidate)
    .map(entry => entry.candidate);
  otherDomains.sort((a, b) => {
    const aSeen = occupiedReviewDomains.has(a.domain) ? 1 : 0;
    const bSeen = occupiedReviewDomains.has(b.domain) ? 1 : 0;
    return aSeen - bSeen;
  });
  const candidates = [
    ...(recommendationCandidate ? [recommendationCandidate] : []),
    ...reviews,
    ...otherDomains,
  ];

  const selected = [];
  const omittedReviews = [];
  let estimatedDurationSec = 0;
  for (const candidate of candidates) {
    const estimateSec = estimateQuickDrillDurationSec(candidate, observedDurations);
    const fits = estimatedDurationSec + estimateSec <= budgetSec;
    if (fits) {
      selected.push({ ...candidate, estimateSec });
      estimatedDurationSec += estimateSec;
    } else if (candidate.kind === 'review') {
      omittedReviews.push(candidate.reviewLabel || candidate.type);
    }
  }

  const selectedDomains = new Set(selected.filter(c => c.kind === 'drill').map(c => c.domain));
  const omittedDomains = domains
    .filter(entry => !selectedDomains.has(entry.domain))
    .map(entry => entry.domain);

  return {
    selected,
    omittedDomains,
    omittedReviews,
    estimatedDurationSec,
    targetDurationSec,
    toleranceSec: Math.max(0, toleranceSec),
    budgetSec,
    withinBudget: estimatedDurationSec <= budgetSec,
  };
}
