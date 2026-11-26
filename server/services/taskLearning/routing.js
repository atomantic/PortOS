/**
 * Task Learning — heuristic routing & scheduling decisions
 *
 * The "read" side of the learning data that drives runtime decisions:
 * priority multipliers, advisory model-tier suggestions (reported in the CoS
 * Learning view, never applied at dispatch — #8149), routing-accuracy matrices,
 * the advisory low-success list, and per-task-type confidence tiers. None of
 * these mutate the store.
 */

import { loadLearningData, isSandboxedTaskType, computeEffectiveSuccessRate, isSkipCandidate, DEFAULT_WINDOW_MAX_AGE_MS, ENVIRONMENTAL_ERROR_CATEGORIES } from './store.js';
import { computeCorrelationQuality, isCorrelationProven } from './correlationQuality.js';

/**
 * Relative resource cost of each tier name that can land in
 * `routingAccuracy`, lightest → heaviest. Used to break ties between tiers
 * that both clear the high-success threshold: prefer the cheapest tier that
 * still works well.
 *
 * The keys here are whatever `selectModelForTask` recorded as `tier`
 * (agentModelSelection.js → agentLifecycle.js `modelTier`). Today that is a
 * literal tier (`light`/`default`/`medium`/`heavy`/`ultra`) or
 * `user-specified`, but learning data recorded before #8149 also carries the
 * retired thinking-level names (`off`/`minimal`/`low`/`medium`/`high`/
 * `xhigh`, where `minimal`/`low` were local-preferred and therefore the
 * cheapest, and `high`/`xhigh` mapped to the provider's heavy model). An unknown name
 * (e.g. `user-specified`, or a future tier) must NOT be treated as cheap, or
 * the "prefer lightest" logic would pick it over a known-light tier — so the
 * fallback ranks unknowns as heaviest.
 */
const TIER_WEIGHT = {
  minimal: 0,   // local-small (thinking level)
  low: 1,       // local-medium (thinking level)
  light: 2,     // provider light model (e.g. haiku)
  off: 3,       // no extended thinking → provider default
  default: 3,   // provider default model
  medium: 4,    // provider default + standard cloud thinking
  high: 5,      // provider-heavy (thinking level)
  heavy: 6,     // provider heavy model
  xhigh: 7      // opus / heaviest (thinking level)
};
const HEAVIEST_WEIGHT = Math.max(...Object.values(TIER_WEIGHT)) + 1;
const tierWeight = (tier) => TIER_WEIGHT[tier] ?? HEAVIEST_WEIGHT;

/**
 * Tier names the learning→selection path can't actually route to. The
 * local-preferred thinking levels (`minimal`/`low`) resolve to a local model
 * (LM Studio/Ollama), but `selectModelForTask` doesn't switch the active
 * provider for them (the `localPreferred` flag is unwired) — so a task can't
 * be routed there from a learned suggestion. Excluding them from suggestion
 * candidates is what keeps "prefer the lightest tier" honest: recommending a
 * tier nothing can run would make the selector fall through to the provider
 * default instead of the lightest tier it CAN run (e.g. `light`). They stay in
 * TIER_WEIGHT (the cost ordering is still accurate) — they're just not offered.
 */
// Ultra is an explicit capability request, never an automatic learned upgrade.
const NON_ROUTABLE_LEARNED_TIERS = new Set(['minimal', 'low', 'ultra']);

/**
 * True for a learned tier the selection path can't actually route to
 * (`minimal`/`low`). Exported so the correlation window (metrics.js) can skip
 * these the same way `deriveFailureSignalAvoidance` does — recording a
 * never-flaggable tier as "predicted safe" would skew the global gauge (#2344).
 */
export const isNonRoutableLearnedTier = (tier) => NON_ROUTABLE_LEARNED_TIERS.has(tier);

/**
 * A recorded tier name → the tier a user can actually pin today, or null.
 * Learning data from before #8149 carries the retired thinking-level names;
 * pinning one (`high`) would be read as a literal model id, so advice maps them
 * onto the tier they resolved to (`off` → the provider default, `high`/`xhigh`
 * → heavy). `user-specified` and the local-only levels name no pinnable tier,
 * so they never appear as advice — their history stays in the matrix.
 */
const ADVISORY_TIERS = Object.freeze({
  light: 'light', medium: 'medium', heavy: 'heavy', ultra: 'ultra', default: 'default',
  off: 'default', high: 'heavy', xhigh: 'heavy',
});
const advisoryTier = (tier) => (Object.hasOwn(ADVISORY_TIERS, tier) ? ADVISORY_TIERS[tier] : null);

/** Minimum success rate (%) for a tier to count as "proven" for a task type. */
const HIGH_SUCCESS_THRESHOLD = 80;

/**
 * Minimum recent failure samples on a single tier (scoped to a task type) before
 * the enriched failure signatures can steer routing away from it. Matches the
 * routingAccuracy "≥3 attempts" bar so a one-off failure never condemns a tier.
 * This is the AGGRESSIVE bar, used once the correlation-quality window has proven
 * the signal predicts outcomes well (>0.8, issue #2344).
 */
const MIN_FAILURE_SAMPLES = 3;

/**
 * Conservative failure-sample bar used until the correlation-quality window
 * proves the enriched signal actually predicts bad outcomes (issue #2344). While
 * the signal is unproven, require MORE recent failures before steering off a
 * tier, so the system doesn't over-correct on a signal that hasn't earned it.
 */
const CONSERVATIVE_MIN_FAILURE_SAMPLES = 5;

/** NUL separator joining provider+model into one tally key (safe: neither contains NUL). */
const PAIR_SEP = '\x00';

/** Key with the highest count in a `{ key: count }` tally (null when empty). */
function topKey(counts) {
  let best = null;
  let bestCount = -1;
  for (const [key, count] of Object.entries(counts)) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  return best;
}

/**
 * Consume the enriched failure signatures (issue #2329) to derive a
 * recency-weighted tier avoidance for a task type. Pure — no I/O.
 *
 * `routingAccuracy` tracks per-tier success/failure counts but carries no
 * provider/model attribution and is all-time (slow to react). The
 * `failureSignatures.recent[]` samples (recorded by #2332) DO carry
 * provider/model/tier attribution and are recency-bounded. This cross-references
 * the two: a tier is steered away from only when it BOTH accumulates ≥
 * MIN_FAILURE_SAMPLES recent failures for this task type AND is *unproven* in
 * routingAccuracy (success rate < HIGH_SUCCESS_THRESHOLD, or no success data).
 *
 * Proven tiers (≥80% success) keep their slot despite a few absolute failures —
 * failureSignatures records failures ONLY, so raw counts can never condemn a
 * tier on their own (a tier with 100 successes + 3 failures is fine). The
 * cross-check is what keeps this from starving a good tier.
 *
 * `minFailureSamples` (issue #2344) is the failure-sample bar a tier must clear
 * before it is steered away from. Callers pass the conservative bar until the
 * correlation-quality window proves the signal predicts outcomes (>0.8); default
 * stays at the aggressive `MIN_FAILURE_SAMPLES` for back-compat with direct
 * callers/tests.
 *
 * `maxAgeMs` (issue #2619) windows the recent samples by age at read time,
 * mirroring `computeWindowedStats`: a failure sample older than the window is
 * ignored, so a fixed low-frequency type stops being steered off a tier by an
 * outage-era sample that never gets pushed out of the count-capped ring. An
 * undated sample (unparseable `recordedAt`) is kept — the count cap still bounds
 * it. Defaults to the shared 30-day window.
 *
 * @returns {{ avoidTiers: string[], sampleCount: number,
 *   dominant: { tier, failures, provider, model }|null }}
 */
export function deriveFailureSignalAvoidance(data, taskType, {
  minFailureSamples = MIN_FAILURE_SAMPLES,
  maxAgeMs = DEFAULT_WINDOW_MAX_AGE_MS,
  now = Date.now()
} = {}) {
  const signatures = data?.failureSignatures || {};
  const routing = data?.routingAccuracy?.[taskType] || {};
  const ageCutoff = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? now - maxAgeMs : null;

  // Gather recent failure samples scoped to this task type across all
  // categories — except environmental ones (issue #2618): failureSignatures
  // deliberately still records outage-class samples for diagnostics, but a
  // burst of rate-limit failures says nothing about the tier, so it must not
  // reach avoidTiers through this secondary signal either.
  const byTier = {};
  let sampleCount = 0;
  for (const [category, bucket] of Object.entries(signatures)) {
    if (ENVIRONMENTAL_ERROR_CATEGORIES.has(category)) continue;
    for (const sample of bucket?.recent || []) {
      if (sample?.taskType !== taskType || !sample.modelTier) continue;
      if (NON_ROUTABLE_LEARNED_TIERS.has(sample.modelTier)) continue;
      // Age-window (#2619): drop a sample with a parseable timestamp older than
      // the window; keep an undated one (the count cap still bounds it).
      if (ageCutoff !== null) {
        const ts = Date.parse(sample.recordedAt);
        if (Number.isFinite(ts) && ts < ageCutoff) continue;
      }
      sampleCount++;
      const tier = (byTier[sample.modelTier] ||= { failures: 0, pairs: {} });
      tier.failures++;
      // Tally provider+model as ONE pair so the reported attribution is a
      // combination that actually failed together (not a top-provider crossed
      // with an unrelated top-model). NUL-joined; '' encodes an absent side.
      const pairKey = `${sample.provider ?? ''}${PAIR_SEP}${sample.model ?? ''}`;
      tier.pairs[pairKey] = (tier.pairs[pairKey] || 0) + 1;
    }
  }

  const avoidTiers = [];
  let dominant = null;
  for (const [tier, stats] of Object.entries(byTier)) {
    const r = routing[tier];
    const attempts = r ? (r.succeeded + r.failed) : 0;
    // null = no success data (not "0% success") — an unproven tier by default.
    const successRate = attempts > 0 ? Math.round((r.succeeded / attempts) * 100) : null;
    const proven = successRate !== null && successRate >= HIGH_SUCCESS_THRESHOLD;
    if (proven || stats.failures < minFailureSamples) continue;
    avoidTiers.push(tier);
    // `dominant` is the AVOIDED tier with the most recent failures — the tier we
    // actually steer away from — so the attribution surfaced in logs/reasons can
    // never name a proven tier that isn't in avoidTiers. null when nothing avoided.
    if (!dominant || stats.failures > dominant.failures) {
      const [provider, model] = (topKey(stats.pairs) || PAIR_SEP).split(PAIR_SEP);
      dominant = { tier, failures: stats.failures, provider: provider || null, model: model || null };
    }
  }

  return { avoidTiers, sampleCount, dominant };
}

/** Union two tier lists, preserving order and dropping duplicates. */
function mergeAvoidTiers(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

/**
 * Tiers with at least one RECENT failure sample for this task type, read from
 * the enriched `failureSignatures.recent[]` rings (issue #2617). Pure.
 *
 * The task-type `recentOutcomes` ring carries no tier identity, so a healthy
 * task-wide recent window alone cannot prove that a specific tier's failure
 * evidence is stale — the recent successes may all have run on a DIFFERENT
 * tier. The failure samples DO carry `modelTier` + `recordedAt`, so this is
 * the tier-scoped recency signal: a failing tier that appears here failed
 * recently and must keep being steered away from; one that doesn't has only
 * stale (pre-window) failure evidence.
 */
function tiersWithRecentFailures(data, taskType, { now = Date.now(), maxAgeMs = DEFAULT_WINDOW_MAX_AGE_MS } = {}) {
  const tiers = new Set();
  for (const [category, bucket] of Object.entries(data?.failureSignatures || {})) {
    // Environmental categories can't mark a tier as recently-failing (#2618).
    if (ENVIRONMENTAL_ERROR_CATEGORIES.has(category)) continue;
    for (const sample of bucket?.recent || []) {
      if (sample?.taskType !== taskType || !sample.modelTier) continue;
      const t = Date.parse(sample.recordedAt);
      if (Number.isFinite(t) && now - t <= maxAgeMs) tiers.add(sample.modelTier);
    }
  }
  return tiers;
}

/**
 * Suggest model tier based on historical performance for a task type
 * Enhanced with negative signal awareness: avoids tiers that consistently fail
 * and prefers tiers with proven success for the task type.
 *
 * ADVISORY ONLY (#8149): surfaced per task type by `getRoutingAccuracy` for the
 * CoS Learning view. Dispatch never reads it — a tier the user did not ask for
 * silently replaced a task's configured default model (#8148).
 */
export async function suggestModelTier(taskType) {
  // Sandboxed fallback (issue #2333): the `external/untyped` bucket aggregates
  // heterogeneous work, so its tier success rates are meaningless — never let it
  // drive a model-tier suggestion.
  if (isSandboxedTaskType(taskType)) return null;
  return suggestModelTierFrom(await loadLearningData(), taskType);
}

// `suggestModelTier` over an already-loaded snapshot, so a caller walking every
// task type (getRoutingAccuracy) loads — and clones — the store once, not per row.
function suggestModelTierFrom(data, taskType) {
  if (isSandboxedTaskType(taskType)) return null;

  // Auto-adjustment aggressiveness gate (issue #2344): the enriched failure
  // signal steers routing more aggressively only once the correlation-quality
  // window proves it actually predicts bad outcomes (>0.8). Until then, require a
  // higher failure-sample bar so the system doesn't over-correct on an unproven
  // signal. Computed synchronously from the already-loaded window — no extra I/O.
  const correlationQuality = computeCorrelationQuality(data.correlationWindow);
  const aggressive = isCorrelationProven(correlationQuality);
  const minFailureSamples = aggressive ? MIN_FAILURE_SAMPLES : CONSERVATIVE_MIN_FAILURE_SAMPLES;

  // Recency-weighted, provider-attributed avoidance from the enriched failure
  // signatures (#2329) — folded into every suggestion below so a tier that's
  // freshly degrading is steered away from before its all-time routingAccuracy
  // rate crosses the hard misroute line. Computed BEFORE the completions guard:
  // the signal has its own failure-sample bar, so recent failures on a tier can
  // steer selection even before routingAccuracy has enough data to suggest a
  // tier at all.
  const failureAvoidance = deriveFailureSignalAvoidance(data, taskType, { minFailureSamples });
  const withFailureSignal = (suggestion, existingAvoid = []) => {
    const avoidTiers = mergeAvoidTiers(existingAvoid, failureAvoidance.avoidTiers);
    // If the tier we were about to suggest is itself failure-flagged (a 60-79%
    // "successful" tier, or the generic `heavy` fallback), don't route to it —
    // drop to avoidance-only (suggested: null) so selection steers off it and
    // picks the best non-avoided tier instead of the tier the signal condemned.
    const suggested = avoidTiers.includes(suggestion.suggested) ? null : suggestion.suggested;
    return {
      ...suggestion,
      suggested,
      avoidTiers,
      ...(failureAvoidance.dominant ? { failureSignal: failureAvoidance.dominant } : {})
    };
  };
  // Avoidance-only suggestion (no positive tier pick) built purely from the
  // failure signal — used both below the completions threshold and as the final
  // fallback when routingAccuracy is quiet.
  const avoidanceOnlySuggestion = () => {
    const { dominant } = failureAvoidance;
    return withFailureSignal({
      suggested: null,
      reason: `${taskType} shows ${dominant.failures} recent failure(s) on ${dominant.tier} tier`
        + (dominant.provider ? ` via ${dominant.provider}${dominant.model ? `/${dominant.model}` : ''}` : '')
        + ' — avoiding it'
    });
  };

  const metrics = data.byTaskType[taskType];
  if (!metrics || metrics.completed < 5) {
    // Not enough completions for a routingAccuracy-based tier suggestion, but a
    // strong recency signal can still steer selection off a freshly-failing tier.
    return failureAvoidance.avoidTiers.length > 0 ? avoidanceOnlySuggestion() : null;
  }

  // Effective (windowed-when-available) task-type rate (issue #2617). Used both
  // to gate the all-time failing-tier branch below and in the low-success
  // fallback: routingAccuracy's per-tier counters have no recency window of
  // their own, so after a since-fixed failure burst a tier reads "failing"
  // forever — when the type's recent window is healthy, that all-time evidence
  // is stale and must not steer routing (to `heavy`, or away from the very tier
  // that is currently succeeding).
  const effective = computeEffectiveSuccessRate(metrics);
  const recentlyHealthy = effective.source === 'windowed' && effective.successRate >= 60;

  // Check routing accuracy for tier-specific signals
  const routingData = data.routingAccuracy?.[taskType];
  if (routingData) {
    // Find tiers with enough data and their success rates
    const tierResults = Object.entries(routingData)
      .filter(([tier, r]) => (r.succeeded + r.failed) >= 3 && !NON_ROUTABLE_LEARNED_TIERS.has(tier))
      .map(([tier, r]) => {
        const total = r.succeeded + r.failed;
        return { tier, successRate: Math.round((r.succeeded / total) * 100), total };
      })
      .sort((a, b) => b.successRate - a.successRate);

    // Among tiers that clear the high-success threshold, prefer the LIGHTEST
    // (cheapest) one — there's no reason to spend a heavier model when a
    // lighter tier already succeeds reliably. tierResults is sorted by success
    // rate, so without this a heavy tier at 85% would beat a light tier at 82%
    // and silently over-allocate compute for the same outcome.
    const provenTiers = tierResults.filter(t => t.successRate >= HIGH_SUCCESS_THRESHOLD);
    if (provenTiers.length > 0) {
      const lightest = provenTiers.reduce((a, b) =>
        tierWeight(b.tier) < tierWeight(a.tier) ? b : a);
      const reason = provenTiers.length > 1
        ? `${taskType} succeeds with ${lightest.tier} tier (${lightest.successRate}%) — using lightest of ${provenTiers.length} proven tiers`
        : `${taskType} has ${lightest.successRate}% success with ${lightest.tier} tier`;
      return withFailureSignal(
        { suggested: lightest.tier, reason },
        tierResults.filter(t => t.successRate < 40).map(t => t.tier)
      );
    }

    // If current default tier is failing, find a better one. Recency gate
    // (issue #2617): skip this branch only when the type's recent window is
    // healthy AND none of the "failing" tiers has a recent failure on record
    // (tiersWithRecentFailures) — then the all-time tier rates are stale
    // evidence from a since-fixed burst, and acting on them would route a
    // currently-working type to `heavy` (and steer selection off the tier it
    // is presently succeeding on) indefinitely. A failing tier with RECENT
    // failure samples keeps its evidence: the task-wide recovery may have
    // happened on a different tier, and the ring carries no tier identity.
    const failingTiers = tierResults.filter(t => t.successRate < 40);
    const recentFailTiers = tiersWithRecentFailures(data, taskType);
    const failingEvidenceStale = recentlyHealthy && !failingTiers.some(t => recentFailTiers.has(t.tier));
    if (failingTiers.length > 0 && !failingEvidenceStale) {
      const successfulTier = tierResults.find(t => t.successRate >= 60);
      return withFailureSignal(
        {
          suggested: successfulTier?.tier || 'heavy',
          reason: `${taskType} fails with ${failingTiers.map(t => t.tier).join(', ')} (${failingTiers.map(t => `${t.successRate}%`).join(', ')})`
        },
        failingTiers.map(t => t.tier)
      );
    }
  }

  // Fallback: if the overall EFFECTIVE success rate is low (issue #2617:
  // windowed when the ring has enough samples, else lifetime), suggest a
  // heavier model. On the lifetime rate alone, a type that recovered from a
  // since-fixed failure burst would be routed to `heavy` forever.
  if (effective.successRate !== null && effective.successRate < 60) {
    return withFailureSignal({
      suggested: 'heavy',
      reason: `${taskType} has ${effective.successRate}% success rate - heavier model may help`
    });
  }

  // No tier-level or overall signal, but the enriched failure signatures flagged
  // a currently-degrading tier — emit an avoidance-only suggestion so selection
  // steers off it (agentModelSelection picks the best non-avoided tier) even
  // though the all-time routingAccuracy rate hasn't crossed the misroute line.
  if (failureAvoidance.avoidTiers.length > 0) {
    return avoidanceOnlySuggestion();
  }

  return null; // Current selection is working fine
}

/**
 * Get routing accuracy metrics showing which model tiers succeed/fail for each task type
 * Returns a matrix suitable for display in the Learning tab UI
 */
export async function getRoutingAccuracy() {
  return summarizeRoutingAccuracy(await loadLearningData());
}

export function summarizeRoutingAccuracy(data) {
  const routingData = data.routingAccuracy || {};

  const matrix = [];
  const tierSummary = {};

  for (const [taskType, tiers] of Object.entries(routingData)) {
    const taskEntry = { taskType, tiers: [] };

    for (const [tier, counts] of Object.entries(tiers)) {
      const total = counts.succeeded + counts.failed;
      if (total === 0) continue;

      const successRate = Math.round((counts.succeeded / total) * 100);
      taskEntry.tiers.push({
        tier,
        succeeded: counts.succeeded,
        failed: counts.failed,
        total,
        successRate,
        lastAttempt: counts.lastAttempt
      });

      // Aggregate tier summary
      if (!tierSummary[tier]) {
        tierSummary[tier] = { succeeded: 0, failed: 0, taskTypes: 0, misroutes: 0 };
      }
      tierSummary[tier].succeeded += counts.succeeded;
      tierSummary[tier].failed += counts.failed;
      tierSummary[tier].taskTypes++;
      if (successRate < 40 && total >= 3) {
        tierSummary[tier].misroutes++;
      }
    }

    // Sort tiers by success rate descending
    taskEntry.tiers.sort((a, b) => b.successRate - a.successRate);
    if (taskEntry.tiers.length > 0) {
      matrix.push(taskEntry);
    }
  }

  // Calculate tier-level success rates
  const tierOverview = Object.entries(tierSummary).map(([tier, s]) => {
    const total = s.succeeded + s.failed;
    return {
      tier,
      successRate: total > 0 ? Math.round((s.succeeded / total) * 100) : 0,
      total,
      taskTypes: s.taskTypes,
      misroutes: s.misroutes
    };
  }).sort((a, b) => b.successRate - a.successRate);

  // Identify misroutes: task+tier combos with <40% success and 3+ attempts
  const misroutes = [];
  for (const entry of matrix) {
    for (const tier of entry.tiers) {
      if (tier.successRate < 40 && tier.total >= 3) {
        misroutes.push({
          taskType: entry.taskType,
          tier: tier.tier,
          successRate: tier.successRate,
          failed: tier.failed,
          total: tier.total
        });
      }
    }
  }
  misroutes.sort((a, b) => a.successRate - b.successRate);

  // Advice, not routing: the tier each task type's history recommends, for the
  // user to pin on the task or schedule if they agree.
  for (const entry of matrix) {
    const suggestion = suggestModelTierFrom(data, entry.taskType);
    const tier = advisoryTier(suggestion?.suggested);
    const avoidTiers = [...new Set((suggestion?.avoidTiers || []).map(advisoryTier).filter(Boolean))];
    if (tier || avoidTiers.length > 0) {
      entry.suggestion = { tier, avoidTiers, reason: suggestion.reason || null };
    }
  }

  return { matrix, tierOverview, misroutes, totalMisroutes: misroutes.length };
}

/**
 * Get a performance summary for logging during task evaluation
 * Provides insights about how different task types are performing
 */
export async function getPerformanceSummary(options) {
  return summarizePerformance(await loadLearningData(), options);
}

export function summarizePerformance(data, { sinceByTaskType = {}, since = null } = {}) {
  const summary = {
    totalCompleted: data.totals.completed,
    overallSuccessRate: data.totals.completed > 0
      ? Math.round((data.totals.succeeded / data.totals.completed) * 100)
      : 0,
    avgDurationMin: Math.round(data.totals.avgDurationMs / 60000),
    topPerformers: [],
    needsAttention: [],
    skipped: []
  };

  // Analyze each task type on the EFFECTIVE rate (issue #2617) so this
  // summary — logged during evaluation and served to the Learning UI — agrees
  // with the actual cooldown/skip decisions instead of resurrecting the
  // "punished forever" lifetime view they just stopped using.
  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    if (metrics.completed < 3) continue;

    // Alert acknowledgements reset only the evidence window, never learning
    // history or scheduler decisions. Undated samples cannot prove a new issue.
    const cutoff = Math.max(Date.parse(since) || 0, Date.parse(sinceByTaskType[taskType]) || 0);
    const alertMetrics = cutoff ? { ...metrics, recentOutcomes: (metrics.recentOutcomes || [])
      .filter(outcome => Date.parse(outcome.t) > cutoff) } : metrics;
    const { successRate, source: rateSource, windowedCompleted } = computeEffectiveSuccessRate(alertMetrics);
    if (cutoff && rateSource !== 'windowed') continue;
    const entry = {
      taskType,
      successRate,
      // Evidence pairing (issue #2617): a windowed rate must travel with its
      // own sample count — "0% success across 200 tasks" (lifetime completed
      // next to a 6-sample windowed rate) materially overstates the evidence.
      rateSource,
      windowedCompleted,
      completed: metrics.completed,
      lastCompleted: metrics.lastCompleted || null,
      avgDurationMin: Math.round(metrics.avgDurationMs / 60000)
    };

    if (successRate >= 80) {
      summary.topPerformers.push(entry);
    } else if (successRate !== null && successRate < 50 && metrics.completed >= 5) {
      summary.needsAttention.push(entry);
      // Also mark as skipped if very low (same predicate as getSkippedTaskTypes)
      if (isSkipCandidate(alertMetrics)) {
        summary.skipped.push(entry);
      }
    }
  }

  // Sort by success rate
  summary.topPerformers.sort((a, b) => b.successRate - a.successRate);
  summary.needsAttention.sort((a, b) => a.successRate - b.successRate);

  return summary;
}

/**
 * Get all task types that should be skipped due to poor performance
 * Useful for filtering out problematic task types in evaluateTasks
 */
export async function getSkippedTaskTypes() {
  return findLowSuccessTaskTypes(await loadLearningData());
}

export function findLowSuccessTaskTypes(data) {
  const skipped = [];

  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    // Sandboxed fallback is never globally skipped (issue #2333).
    if (isSandboxedTaskType(taskType)) continue;
    // Skip if: completed >= 5 AND effective success rate < 30%
    if (isSkipCandidate(metrics)) {
      const { successRate, source: rateSource, windowedCompleted } = computeEffectiveSuccessRate(metrics);
      skipped.push({
        taskType,
        successRate,
        // Evidence pairing (issue #2617): a windowed rate ships with its own
        // sample count so consumers never render it beside the lifetime total.
        rateSource,
        windowedCompleted,
        completed: metrics.completed,
        lastCompleted: metrics.lastCompleted
      });
    }
  }

  return skipped;
}

/**
 * Pure classifier — returns { tier, autoApprove, successRate, rateSource } for
 * a given metrics object. Shared by getTaskTypeConfidence() and
 * getConfidenceLevels() so the auto-approve gate and the Learning tab display
 * always agree. Classifies on the EFFECTIVE success rate (issue #2617):
 * windowed when the outcome ring has enough samples, else lifetime — so a type
 * with a poor lifetime rate but a healthy recent window regains auto-approval.
 * The returned `successRate` is the rate the tier was classified on.
 */
function classifyConfidenceTier(metrics, { highThreshold = 80, lowThreshold = 50, minSamples = 5 } = {}) {
  const completed = metrics?.completed ?? 0;
  const effective = computeEffectiveSuccessRate(metrics);
  // Compare on a 0-defaulted value, but RETURN the raw nullable rate — the
  // null sentinel ("no rate recorded") must survive to callers (repo
  // absent-vs-empty rule), not collapse into a fabricated 0%.
  const rate = effective.successRate ?? 0;
  const result = { successRate: effective.successRate, rateSource: effective.source, windowedCompleted: effective.windowedCompleted };

  if (completed < minSamples) return { tier: 'new', autoApprove: true, ...result };
  if (rate >= highThreshold) return { tier: 'high', autoApprove: true, ...result };
  if (rate >= lowThreshold) return { tier: 'medium', autoApprove: true, ...result };
  return { tier: 'low', autoApprove: false, ...result };
}

/**
 * Calculate confidence tier for a specific task type based on learning data.
 *
 * @param {string} taskType - The task type to evaluate
 * @param {Object} [thresholds] - Override default thresholds
 * @returns {Promise<Object>} Confidence assessment
 */
export async function getTaskTypeConfidence(taskType, thresholds = {}) {
  const data = await loadLearningData();
  const metrics = data.byTaskType[taskType];
  const { tier, autoApprove, successRate, rateSource, windowedCompleted } = classifyConfidenceTier(metrics, thresholds);

  // Reasons quote the EFFECTIVE rate the tier was classified on (issue #2617),
  // annotated when it came from the recency window — and paired with the
  // WINDOW's sample count, not the lifetime one, so "100% recent success
  // across 15 recent runs" never overstates its evidence as 200 lifetime runs.
  const rateLabel = rateSource === 'windowed' ? `${successRate ?? 0}% recent success` : `${successRate ?? 0}% success`;
  const attemptsLabel = rateSource === 'windowed' ? `${windowedCompleted} recent runs` : `${metrics?.completed} runs`;
  const reasons = {
    new: `Fewer than ${thresholds.minSamples ?? 5} completions — auto-approve by default`,
    high: `${rateLabel} across ${attemptsLabel} — high confidence`,
    medium: `${rateLabel} — acceptable confidence`,
    low: `${rateLabel} after ${attemptsLabel} — requires approval`
  };

  return {
    taskType,
    tier,
    autoApprove,
    // Nullable: preserves the "no rate recorded" sentinel (absent bucket OR a
    // bucket without a stored rate and a thin window) instead of a fake 0.
    successRate,
    rateSource,
    windowedCompleted,
    completed: metrics?.completed ?? 0,
    reason: reasons[tier]
  };
}

/**
 * Get confidence levels for all tracked task types.
 * Returns a summary suitable for display in the Learning tab UI.
 *
 * @param {Object} [thresholds] - Override default thresholds
 * @returns {Promise<Object>} All task types grouped by confidence tier
 */
export async function getConfidenceLevels(thresholds) {
  return summarizeConfidenceLevels(await loadLearningData(), thresholds);
}

export function summarizeConfidenceLevels(data, thresholds = {}) {
  const levels = { high: [], medium: [], low: [], new: [] };

  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    const { tier, autoApprove, successRate, rateSource, windowedCompleted } = classifyConfidenceTier(metrics, thresholds);
    levels[tier].push({
      taskType,
      successRate: successRate ?? 0, // display list keeps the pre-existing 0 default
      rateSource,
      windowedCompleted,
      completed: metrics.completed || 0,
      autoApprove,
      lastCompleted: metrics.lastCompleted
    });
  }

  for (const tier of Object.values(levels)) {
    tier.sort((a, b) => b.successRate - a.successRate);
  }

  const { highThreshold = 80, lowThreshold = 50, minSamples = 5 } = thresholds;
  return {
    levels,
    thresholds: { highThreshold, lowThreshold, minSamples },
    summary: {
      high: levels.high.length,
      medium: levels.medium.length,
      low: levels.low.length,
      new: levels.new.length,
      total: Object.values(levels).reduce((sum, arr) => sum + arr.length, 0),
      requireApproval: levels.low.length
    }
  };
}
