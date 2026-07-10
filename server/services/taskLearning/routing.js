/**
 * Task Learning — heuristic routing & scheduling decisions
 *
 * The "read" side of the learning data that drives runtime decisions:
 * priority multipliers, model-tier suggestions, routing-accuracy matrices,
 * adaptive cooldowns, skip/rehabilitation gating, and per-task-type
 * confidence tiers. None of these mutate the store except the
 * rehabilitation path, which delegates the actual reset to the metrics
 * module.
 */

import { loadLearningData, emitLog, isSandboxedTaskType } from './store.js';
import { resetTaskTypeLearning } from './metrics.js';
import { computeCorrelationQuality, isCorrelationProven } from './correlationQuality.js';

/**
 * Relative resource cost of each tier name that can land in
 * `routingAccuracy`, lightest → heaviest. Used to break ties between tiers
 * that both clear the high-success threshold: prefer the cheapest tier that
 * still works well.
 *
 * The keys here are whatever `selectModelForTask` records as `tier`
 * (agentModelSelection.js → agentLifecycle.js `modelTier`), which is a mixed
 * namespace: the literal tiers (`light`/`default`/`medium`/`heavy`) AND the
 * thinking-level names from thinkingLevels.js (`off`/`minimal`/`low`/`medium`/
 * `high`/`xhigh`, where `minimal`/`low` are local-preferred and therefore the
 * cheapest, and `high`/`xhigh` map to provider-heavy/opus). An unknown name
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
const NON_ROUTABLE_LEARNED_TIERS = new Set(['minimal', 'low']);

/**
 * True for a learned tier the selection path can't actually route to
 * (`minimal`/`low`). Exported so the correlation window (metrics.js) can skip
 * these the same way `deriveFailureSignalAvoidance` does — recording a
 * never-flaggable tier as "predicted safe" would skew the global gauge (#2344).
 */
export const isNonRoutableLearnedTier = (tier) => NON_ROUTABLE_LEARNED_TIERS.has(tier);

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
 * @returns {{ avoidTiers: string[], sampleCount: number,
 *   dominant: { tier, failures, provider, model }|null }}
 */
export function deriveFailureSignalAvoidance(data, taskType, { minFailureSamples = MIN_FAILURE_SAMPLES } = {}) {
  const signatures = data?.failureSignatures || {};
  const routing = data?.routingAccuracy?.[taskType] || {};

  // Gather recent failure samples scoped to this task type across all categories.
  const byTier = {};
  let sampleCount = 0;
  for (const bucket of Object.values(signatures)) {
    for (const sample of bucket?.recent || []) {
      if (sample?.taskType !== taskType || !sample.modelTier) continue;
      if (NON_ROUTABLE_LEARNED_TIERS.has(sample.modelTier)) continue;
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
 * Get suggested priority boost for a task type based on historical success
 * Returns a multiplier: >1 for boost, <1 for demotion
 */
export async function getTaskTypePriorityMultiplier(taskType) {
  const data = await loadLearningData();

  const metrics = data.byTaskType[taskType];
  if (!metrics || metrics.completed < 3) {
    return 1.0; // Not enough data, use default priority
  }

  // High success rate = boost priority
  if (metrics.successRate >= 90) return 1.2;
  if (metrics.successRate >= 75) return 1.1;

  // Low success rate = demote priority slightly (but not too much, as we want to retry)
  if (metrics.successRate < 50) return 0.9;

  return 1.0;
}

/**
 * Suggest model tier based on historical performance for a task type
 * Enhanced with negative signal awareness: avoids tiers that consistently fail
 * and prefers tiers with proven success for the task type
 */
export async function suggestModelTier(taskType) {
  // Sandboxed fallback (issue #2333): the `external/untyped` bucket aggregates
  // heterogeneous work, so its tier success rates are meaningless — never let it
  // drive a model-tier suggestion. Let the selector fall through to its default.
  if (isSandboxedTaskType(taskType)) return null;

  const data = await loadLearningData();

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

    // If current default tier is failing, find a better one
    const failingTiers = tierResults.filter(t => t.successRate < 40);
    if (failingTiers.length > 0) {
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

  // Fallback: if overall success rate is low, suggest heavier model
  if (metrics.successRate < 60) {
    return withFailureSignal({
      suggested: 'heavy',
      reason: `${taskType} has ${metrics.successRate}% success rate - heavier model may help`
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
  const data = await loadLearningData();
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

  return { matrix, tierOverview, misroutes, totalMisroutes: misroutes.length };
}

/**
 * Get a performance summary for logging during task evaluation
 * Provides insights about how different task types are performing
 */
export async function getPerformanceSummary() {
  const data = await loadLearningData();

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

  // Analyze each task type
  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    if (metrics.completed < 3) continue;

    const entry = {
      taskType,
      successRate: metrics.successRate,
      completed: metrics.completed,
      avgDurationMin: Math.round(metrics.avgDurationMs / 60000)
    };

    if (metrics.successRate >= 80) {
      summary.topPerformers.push(entry);
    } else if (metrics.successRate < 50 && metrics.completed >= 5) {
      summary.needsAttention.push(entry);
      // Also mark as skipped if very low
      if (metrics.successRate < 30) {
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
 * Get adaptive cooldown multiplier for a task type based on historical performance
 *
 * This allows the CoS to work more efficiently:
 * - High success rate tasks: Reduced cooldown (can work on similar tasks sooner)
 * - Low success rate tasks: Increased cooldown (give time for fixes/investigation)
 * - Very low success rate: Skip this task type (needs review)
 *
 * @param {string} taskType - The task type (e.g., 'self-improve:ui-bugs')
 * @returns {Object} Cooldown adjustment info
 */
export async function getAdaptiveCooldownMultiplier(taskType) {
  // Sandboxed fallback (issue #2333): never skip or throttle the heterogeneous
  // `external/untyped` bucket — a poor aggregate success rate here would create
  // a routing blind spot that silently drops ALL unclassified work. Keep it at
  // the default cooldown and always eligible.
  if (isSandboxedTaskType(taskType)) {
    return { multiplier: 1.0, reason: 'sandboxed-untyped', skip: false, successRate: null, completed: 0 };
  }

  const data = await loadLearningData();

  const metrics = data.byTaskType[taskType];

  // Not enough data - use default cooldown
  if (!metrics || metrics.completed < 3) {
    return {
      multiplier: 1.0,
      reason: 'insufficient-data',
      skip: false,
      successRate: null,
      completed: metrics?.completed || 0
    };
  }

  const successRate = metrics.successRate;

  // Very high success (90%+): Reduce cooldown by 30% - this task type works well
  if (successRate >= 90) {
    return {
      multiplier: 0.7,
      reason: 'high-success',
      skip: false,
      successRate,
      completed: metrics.completed,
      recommendation: `Task type has ${successRate}% success rate - reduced cooldown`
    };
  }

  // Good success (75-89%): Slight reduction (15%)
  if (successRate >= 75) {
    return {
      multiplier: 0.85,
      reason: 'good-success',
      skip: false,
      successRate,
      completed: metrics.completed
    };
  }

  // Moderate success (50-74%): Default cooldown
  if (successRate >= 50) {
    return {
      multiplier: 1.0,
      reason: 'moderate-success',
      skip: false,
      successRate,
      completed: metrics.completed
    };
  }

  // Low success (30-49%): Increase cooldown by 50%
  if (successRate >= 30) {
    return {
      multiplier: 1.5,
      reason: 'low-success',
      skip: false,
      successRate,
      completed: metrics.completed,
      recommendation: `Task type has only ${successRate}% success rate - increased cooldown`
    };
  }

  // Very low success (<30%) with significant attempts: Skip this task type
  if (metrics.completed >= 5) {
    return {
      multiplier: 0, // Effectively infinite cooldown
      reason: 'skip-failing',
      skip: true,
      successRate,
      completed: metrics.completed,
      recommendation: `Task type has ${successRate}% success rate after ${metrics.completed} attempts - skipping until reviewed`
    };
  }

  // Very low success but few attempts: Double cooldown and keep trying
  return {
    multiplier: 2.0,
    reason: 'very-low-success',
    skip: false,
    successRate,
    completed: metrics.completed,
    recommendation: `Task type has ${successRate}% success rate - doubled cooldown for retry`
  };
}

/**
 * Get all task types that should be skipped due to poor performance
 * Useful for filtering out problematic task types in evaluateTasks
 */
export async function getSkippedTaskTypes() {
  const data = await loadLearningData();
  const skipped = [];

  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    // Sandboxed fallback is never globally skipped (issue #2333).
    if (isSandboxedTaskType(taskType)) continue;
    // Skip if: completed >= 5 AND success rate < 30%
    if (metrics.completed >= 5 && metrics.successRate < 30) {
      skipped.push({
        taskType,
        successRate: metrics.successRate,
        completed: metrics.completed,
        lastCompleted: metrics.lastCompleted
      });
    }
  }

  return skipped;
}

/**
 * Check if a specific task type should be skipped
 */
export async function shouldSkipTaskType(taskType) {
  const result = await getAdaptiveCooldownMultiplier(taskType);
  return result.skip;
}

/**
 * Check if any skipped task types are eligible for automatic rehabilitation
 * Task types that have been skipped for a grace period get a "fresh start" opportunity
 *
 * Auto-rehabilitation rules:
 * - Task must have been skipped (success rate < 30% with 5+ attempts)
 * - Must have been at least rehabilitationGracePeriodMs since last completion
 * - Reset the task type's learning data to give it a fresh chance
 *
 * This allows CoS to automatically retry previously-failing task types
 * after enough time has passed for fixes to be applied.
 *
 * @param {number} gracePeriodMs - Minimum time since last attempt (default: 7 days)
 * @returns {Object} Summary of rehabilitated task types
 */
export async function checkAndRehabilitateSkippedTasks(gracePeriodMs = 7 * 24 * 60 * 60 * 1000) {
  const data = await loadLearningData();
  const rehabilitated = [];
  const now = Date.now();

  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    // Sandboxed fallback is never skipped, so never rehabilitated either (#2333).
    if (isSandboxedTaskType(taskType)) continue;
    // Only consider task types that would be skipped (< 30% success with 5+ attempts)
    if (metrics.completed < 5 || metrics.successRate >= 30) {
      continue;
    }

    // Check if enough time has passed since last attempt
    const lastCompletedTime = metrics.lastCompleted
      ? new Date(metrics.lastCompleted).getTime()
      : 0;
    const timeSinceLastAttempt = now - lastCompletedTime;

    if (timeSinceLastAttempt >= gracePeriodMs) {
      // This task type is eligible for rehabilitation
      emitLog('info', `Auto-rehabilitating ${taskType} (was ${metrics.successRate}% success, ${Math.round(timeSinceLastAttempt / (24 * 60 * 60 * 1000))} days since last attempt)`, {
        taskType,
        previousSuccessRate: metrics.successRate,
        previousAttempts: metrics.completed,
        daysSinceLastAttempt: Math.round(timeSinceLastAttempt / (24 * 60 * 60 * 1000))
      }, '📚 TaskLearning');

      // Reset this task type's data
      await resetTaskTypeLearning(taskType);

      rehabilitated.push({
        taskType,
        previousSuccessRate: metrics.successRate,
        previousAttempts: metrics.completed,
        daysSinceLastAttempt: Math.round(timeSinceLastAttempt / (24 * 60 * 60 * 1000))
      });
    }
  }

  if (rehabilitated.length > 0) {
    emitLog('success', `Auto-rehabilitated ${rehabilitated.length} skipped task type(s)`, {
      rehabilitated: rehabilitated.map(r => r.taskType)
    }, '📚 TaskLearning');
  }

  return { rehabilitated, count: rehabilitated.length };
}

/**
 * Get all skipped task types with their rehabilitation eligibility status
 * Useful for UI display and debugging
 * @param {number} gracePeriodMs - Grace period for rehabilitation eligibility
 * @returns {Array} List of skipped task types with status info
 */
export async function getSkippedTaskTypesWithStatus(gracePeriodMs = 7 * 24 * 60 * 60 * 1000) {
  const data = await loadLearningData();
  const skipped = [];
  const now = Date.now();

  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    // Sandboxed fallback is never skipped (#2333) — exclude from the skip status list.
    if (isSandboxedTaskType(taskType)) continue;
    // Only include task types that would be skipped
    if (metrics.completed < 5 || metrics.successRate >= 30) {
      continue;
    }

    const lastCompletedTime = metrics.lastCompleted
      ? new Date(metrics.lastCompleted).getTime()
      : 0;
    const timeSinceLastAttempt = now - lastCompletedTime;
    const eligibleForRehabilitation = timeSinceLastAttempt >= gracePeriodMs;
    const timeUntilEligible = eligibleForRehabilitation
      ? 0
      : gracePeriodMs - timeSinceLastAttempt;

    skipped.push({
      taskType,
      successRate: metrics.successRate,
      completed: metrics.completed,
      lastCompleted: metrics.lastCompleted,
      daysSinceLastAttempt: Math.round(timeSinceLastAttempt / (24 * 60 * 60 * 1000)),
      eligibleForRehabilitation,
      daysUntilEligible: Math.ceil(timeUntilEligible / (24 * 60 * 60 * 1000))
    });
  }

  return skipped;
}

/**
 * Pure classifier — returns { tier, autoApprove } for a given metrics object.
 * Shared by getTaskTypeConfidence() and getConfidenceLevels().
 */
function classifyConfidenceTier(metrics, { highThreshold = 80, lowThreshold = 50, minSamples = 5 } = {}) {
  const completed = metrics?.completed ?? 0;
  const successRate = metrics?.successRate ?? 0;

  if (completed < minSamples) return { tier: 'new', autoApprove: true };
  if (successRate >= highThreshold) return { tier: 'high', autoApprove: true };
  if (successRate >= lowThreshold) return { tier: 'medium', autoApprove: true };
  return { tier: 'low', autoApprove: false };
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
  const { tier, autoApprove } = classifyConfidenceTier(metrics, thresholds);

  const reasons = {
    new: `Fewer than ${thresholds.minSamples ?? 5} completions — auto-approve by default`,
    high: `${metrics?.successRate}% success across ${metrics?.completed} runs — high confidence`,
    medium: `${metrics?.successRate}% success — acceptable confidence`,
    low: `${metrics?.successRate}% success after ${metrics?.completed} attempts — requires approval`
  };

  return {
    taskType,
    tier,
    autoApprove,
    successRate: metrics?.successRate ?? null,
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
export async function getConfidenceLevels(thresholds = {}) {
  const data = await loadLearningData();
  const levels = { high: [], medium: [], low: [], new: [] };

  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    const { tier, autoApprove } = classifyConfidenceTier(metrics, thresholds);
    levels[tier].push({
      taskType,
      successRate: metrics.successRate ?? 0,
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
