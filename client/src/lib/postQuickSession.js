// Pure planning helpers for the composed POST Quick session. Keeping the
// estimator and composer side-effect free makes the time-budget contract easy
// to test and keeps provider calls out of the planning path.

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

function candidateForDomain(domain, drills, recommendation, memoryItemIds = {}) {
  const list = drills || [];
  if (!list.length) return null;
  const recommended = recommendation?.drillType
    ? list.find(drill => drill.type === recommendation.drillType)
    : null;
  const pick = recommended || list[0];
  const quickConfig = pick.quickConfig || buildQuickDrillConfig({
    ...pick,
    memoryItemId: pick.memoryItemId ?? memoryItemIds[pick.type],
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
 * Compose a stable Quick plan. The top recommendation wins its domain, due
 * review reps come next, and remaining domains are then admitted in their
 * existing registry order while the target+tolerance budget has room.
 */
export function composeQuickSession({
  domainEntries = [],
  recommendation = null,
  reviewReps = [],
  durationMinutes = DEFAULT_QUICK_DURATION_MINUTES,
  toleranceSec = QUICK_DURATION_TOLERANCE_SEC,
  observedDurations = {},
  memoryItemIds = {},
} = {}) {
  const targetDurationSec = normalizeQuickDurationMinutes(durationMinutes) * 60;
  const budgetSec = targetDurationSec + Math.max(0, toleranceSec);
  const domains = domainEntries
    .map(entry => ({
      domain: entry.domain,
      candidate: candidateForDomain(entry.domain, entry.drills, recommendation, memoryItemIds),
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
