/**
 * Task Learning — insights, recommendations & dismissals
 *
 * Builds the user-facing Learning tab payloads: the overall insights view,
 * the generated recommendation list (with dismissal/resurface tracking),
 * ad-hoc recorded insights, and the lightweight dashboard health summary.
 */

import {
  withLock,
  loadLearningData,
  saveLearningData,
  loadDismissedRecommendations,
  saveDismissedRecommendations,
  summarizeFailureSignatures,
  appendInsight,
  computeEffectiveSuccessRate,
  isSkipCandidate
} from './store.js';
import { computeCorrelationQuality, isCorrelationProven, CORRELATION_QUALITY_THRESHOLD } from './correlationQuality.js';

/**
 * Get learning insights for display
 */
export async function getLearningInsights() {
  const data = await loadLearningData();
  const dismissed = await loadDismissedRecommendations();

  // Calculate overall success rate
  const overallSuccessRate = data.totals.completed > 0
    ? Math.round((data.totals.succeeded / data.totals.completed) * 100)
    : 0;

  // Find best and worst performing task types
  const taskTypes = Object.entries(data.byTaskType)
    .map(([type, metrics]) => ({
      type,
      ...metrics
    }))
    .filter(t => t.completed >= 3) // Only include types with enough data
    .sort((a, b) => b.successRate - a.successRate);

  const bestPerforming = taskTypes.slice(0, 3);
  const worstPerforming = taskTypes.slice(-3).reverse();

  // Find most common errors
  const commonErrors = Object.entries(data.errorPatterns)
    .map(([category, info]) => ({
      category,
      count: info.count,
      lastOccurred: info.lastOccurred,
      affectedTypes: Object.keys(info.taskTypes)
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Enriched failure signatures (issue #2333): provider/model attribution and
  // success-criteria miss counts the coarse errorPatterns aggregate can't carry.
  const failureSignatures = summarizeFailureSignatures(data.failureSignatures);

  // Model tier effectiveness
  const modelEffectiveness = Object.entries(data.byModelTier)
    .map(([tier, metrics]) => ({
      tier,
      successRate: metrics.completed > 0
        ? Math.round((metrics.succeeded / metrics.completed) * 100)
        : 0,
      avgDurationMin: Math.round(metrics.avgDurationMs / 60000),
      completed: metrics.completed
    }))
    .sort((a, b) => b.successRate - a.successRate);

  // Correlation-quality gauge (issue #2344): how well the enriched failure
  // signal predicts actual outcomes over the rolling window. `proven` mirrors the
  // routing aggressiveness gate (score > threshold with enough samples).
  const correlationQuality = computeCorrelationQuality(data.correlationWindow);

  return {
    lastUpdated: data.lastUpdated,
    totals: {
      ...data.totals,
      successRate: overallSuccessRate,
      avgDurationMin: Math.round(data.totals.avgDurationMs / 60000)
    },
    correlationQuality: {
      ...correlationQuality,
      threshold: CORRELATION_QUALITY_THRESHOLD,
      // Mirrors the routing aggressiveness gate exactly (single source of truth).
      proven: isCorrelationProven(correlationQuality)
    },
    insights: {
      bestPerforming: bestPerforming.map(t => ({
        type: t.type,
        successRate: t.successRate,
        avgDurationMin: Math.round(t.avgDurationMs / 60000),
        completed: t.completed
      })),
      worstPerforming: worstPerforming.map(t => ({
        type: t.type,
        successRate: t.successRate,
        avgDurationMin: Math.round(t.avgDurationMs / 60000),
        completed: t.completed
      })),
      commonErrors,
      failureSignatures,
      modelEffectiveness,
      recentUnknownErrors: data.recentUnknownErrors || []
    },
    // Standing learnings / operating notes (issue #2443): human-readable insights
    // — auto-recorded recurring-failure incidents plus any user-authored notes —
    // newest first. Runtime-only (data/cos/), surfaced in the CoS UI.
    standingLearnings: (data.insights || []).slice(-20).reverse(),
    recommendations: generateRecommendations(data, bestPerforming, worstPerforming, commonErrors, dismissed, failureSignatures)
  };
}

/**
 * Decide whether a previously-dismissed recommendation should re-surface.
 * For count-based metrics (e.g., error occurrences) we re-alert when the
 * count has grown materially beyond the dismissal snapshot. For rate-based
 * metrics, dismissal is permanent until the user restores — flips the other
 * direction usually mean the recommendation type itself no longer applies
 * (and a different recommendation will be generated instead).
 */
function shouldResurface(dismissedEntry, currentSnapshot) {
  if (!dismissedEntry) return true;
  const prev = dismissedEntry.snapshot;
  if (!prev || !currentSnapshot) return false;
  if (prev.kind !== currentSnapshot.kind) return true;
  if (prev.kind === 'count') {
    const prevValue = Number(prev.value) || 0;
    const currentValue = Number(currentSnapshot.value) || 0;
    return currentValue >= Math.max(prevValue * 1.5, prevValue + 20);
  }
  return false;
}

function pushIfActive(recommendations, dismissed, rec) {
  const dismissedEntry = dismissed[rec.id];
  if (dismissedEntry && !shouldResurface(dismissedEntry, rec.snapshot)) return;
  recommendations.push(rec);
}

/**
 * Generate actionable recommendations based on learning data
 */
function generateRecommendations(data, bestPerforming, worstPerforming, commonErrors, dismissed = {}, failureSignatures = []) {
  const recommendations = [];

  // Recommend focusing on high-success task types
  if (bestPerforming.length > 0 && bestPerforming[0].successRate >= 90) {
    pushIfActive(recommendations, dismissed, {
      id: `top-perf:${bestPerforming[0].type}`,
      type: 'optimization',
      message: `${bestPerforming[0].type} tasks have ${bestPerforming[0].successRate}% success rate - consider increasing frequency`,
      snapshot: { kind: 'rate', value: bestPerforming[0].successRate }
    });
  }

  // Warn about low-success task types
  if (worstPerforming.length > 0 && worstPerforming[0].successRate < 50 && worstPerforming[0].completed >= 5) {
    pushIfActive(recommendations, dismissed, {
      id: `worst-perf:${worstPerforming[0].type}`,
      type: 'warning',
      message: `${worstPerforming[0].type} tasks have only ${worstPerforming[0].successRate}% success rate - may need prompt improvements`,
      snapshot: { kind: 'rate', value: worstPerforming[0].successRate }
    });
  }

  // Check for recurring errors
  if (commonErrors.length > 0 && commonErrors[0].count >= 3) {
    pushIfActive(recommendations, dismissed, {
      id: `error-pattern:${commonErrors[0].category}`,
      type: 'action',
      message: `"${commonErrors[0].category}" errors occurred ${commonErrors[0].count} times - investigate root cause`,
      snapshot: { kind: 'count', value: commonErrors[0].count }
    });
  }

  // Provider/model-attributed failure recommendation (issue #2333): the enriched
  // failureSignatures map can name a specific provider/model behind a recurring
  // failure category — more actionable than the raw errorPatterns count above.
  const attributedSignature = failureSignatures.find(sig => sig.providers[0] && sig.providers[0].count >= 3);
  if (attributedSignature) {
    const topProvider = attributedSignature.providers[0];
    pushIfActive(recommendations, dismissed, {
      id: `failure-signature:${attributedSignature.category}`,
      type: 'action',
      message: `${topProvider.count} recent "${attributedSignature.category}" failures via ${topProvider.key}${attributedSignature.validationMissed > 0 ? ` (${attributedSignature.validationMissed} missed success criteria)` : ''} - investigate or route away`,
      snapshot: { kind: 'count', value: topProvider.count }
    });
  }

  // Check model tier usage
  const heavyTier = data.byModelTier['heavy'];
  const lightTier = data.byModelTier['light'];

  if (lightTier && lightTier.completed > 0) {
    const lightSuccessRate = Math.round((lightTier.succeeded / lightTier.completed) * 100);
    if (lightSuccessRate < 70) {
      pushIfActive(recommendations, dismissed, {
        id: 'tier-low-success:light',
        type: 'suggestion',
        message: `Light model (haiku) has ${lightSuccessRate}% success rate - consider routing more tasks to medium tier`,
        snapshot: { kind: 'rate', value: lightSuccessRate }
      });
    }
  }

  if (heavyTier && heavyTier.completed > 10) {
    const heavySuccessRate = Math.round((heavyTier.succeeded / heavyTier.completed) * 100);
    if (heavySuccessRate >= 95) {
      pushIfActive(recommendations, dismissed, {
        id: 'tier-excellent:heavy',
        type: 'info',
        message: `Heavy model (opus) has ${heavySuccessRate}% success rate - excellent for complex tasks`,
        snapshot: { kind: 'rate', value: heavySuccessRate }
      });
    }
  }

  return recommendations;
}

/**
 * Mark a recommendation as dismissed. Stores a snapshot so we can re-surface
 * if the underlying situation worsens significantly.
 */
export async function dismissRecommendation(id, snapshot = null) {
  return withLock(async () => {
    const map = await loadDismissedRecommendations();
    map[id] = {
      dismissedAt: new Date().toISOString(),
      snapshot
    };
    await saveDismissedRecommendations(map);
    return { id, dismissed: true };
  });
}

/**
 * Restore a single previously-dismissed recommendation.
 */
export async function restoreRecommendation(id) {
  return withLock(async () => {
    const map = await loadDismissedRecommendations();
    if (!map[id]) return { id, restored: false };
    delete map[id];
    await saveDismissedRecommendations(map);
    return { id, restored: true };
  });
}

/**
 * Clear all dismissed recommendations.
 */
export async function clearDismissedRecommendations() {
  return withLock(async () => {
    await saveDismissedRecommendations({});
    return { cleared: true };
  });
}

/**
 * List dismissed recommendations as an array sorted by dismissedAt desc.
 */
export async function getDismissedRecommendations() {
  const map = await loadDismissedRecommendations();
  return Object.entries(map)
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => (b.dismissedAt || '').localeCompare(a.dismissedAt || ''));
}

/**
 * Record a learning insight for future reference. Stores observations about what
 * works and what doesn't. Manual insights (from the API route) default to
 * `origin: 'user'` — the failure path records `origin: 'auto-incident'` inline
 * (see `recordTaskCompletion`) to avoid re-entering the non-reentrant store lock.
 */
export async function recordLearningInsight(insight) {
  return withLock(async () => {
    const data = await loadLearningData();
    appendInsight(data, insight);
    await saveLearningData(data);
    // Return the stamped record (with recordedAt + resolved origin), not the bare input.
    return data.insights[data.insights.length - 1];
  });
}

/**
 * Get recent learning insights (newest last, matching insertion order).
 */
export async function getRecentInsights(limit = 10) {
  const data = await loadLearningData();
  return (data.insights || []).slice(-limit);
}

/**
 * Get a lightweight learning health summary for dashboard display
 * Returns just the key metrics needed for a quick health overview
 */
export async function getLearningSummary() {
  const data = await loadLearningData();

  // Count task types in various health states
  let healthyCount = 0;
  let warningCount = 0;
  let criticalCount = 0;
  let skippedCount = 0;

  // Health tiers read the EFFECTIVE rate (issue #2617) and the skipped count
  // uses the shared skip predicate, so this dashboard summary — and the
  // proactive "task types skipped" alert built on it — reflects what the
  // scheduler actually does. On lifetime rates alone, a type that recovered
  // in its recent window would be alerted as "skipped" forever.
  for (const [, metrics] of Object.entries(data.byTaskType)) {
    if (metrics.completed < 3) continue; // Insufficient data

    const { successRate } = computeEffectiveSuccessRate(metrics);
    if (successRate >= 70) {
      healthyCount++;
    } else if (successRate >= 40) {
      warningCount++;
    } else {
      criticalCount++;
      if (isSkipCandidate(metrics)) {
        skippedCount++;
      }
    }
  }

  const totalTypes = healthyCount + warningCount + criticalCount;

  // Determine overall health status
  let status = 'good';
  let statusMessage = 'All task types healthy';

  if (skippedCount > 0) {
    status = 'critical';
    statusMessage = `${skippedCount} task type${skippedCount > 1 ? 's' : ''} skipped`;
  } else if (criticalCount > 0) {
    status = 'warning';
    statusMessage = `${criticalCount} need${criticalCount === 1 ? 's' : ''} attention`;
  } else if (warningCount > 0) {
    status = 'ok';
    statusMessage = `${warningCount} underperforming`;
  } else if (totalTypes === 0) {
    status = 'none';
    statusMessage = 'No data yet';
  }

  return {
    status,
    statusMessage,
    totalTypes,
    healthy: healthyCount,
    warning: warningCount,
    critical: criticalCount,
    skipped: skippedCount,
    overallSuccessRate: data.totals.completed > 0
      ? Math.round((data.totals.succeeded / data.totals.completed) * 100)
      : null,
    totalCompleted: data.totals.completed
  };
}
