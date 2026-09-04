/**
 * Task Learning — reset leaf
 *
 * Owns the destructive per-task-type reset path (`resetTaskTypeLearning` plus
 * the pure unwind helpers it composes). Split out of `metrics.js` (issue
 * #5916) so `routing.js` — which calls the reset from its rehabilitation path —
 * can import it without closing a metrics⇄routing static import cycle. This
 * module imports only from the shared persistence leaf (`store.js`), so it
 * sits at the bottom of the taskLearning dependency graph alongside it.
 */

import {
  withLock,
  calculateDurationETA,
  emitLog,
  loadLearningData,
  saveLearningData
} from './store.js';

/**
 * Remove a task type's contribution from every environmental bucket (issue
 * #2618 reset parity): decrement each bucket's count by the type's share,
 * delete the per-type entry, and drop a bucket left with nothing — so a reset
 * type's old outages stop appearing in insights and error-share denominators.
 * Pure — mutates `data`. Returns the number of events removed.
 */
export function purgeEnvironmentalFailuresForType(data, taskType) {
  let removed = 0;
  for (const [category, bucket] of Object.entries(data.environmentalFailures || {})) {
    const typeCount = bucket.taskTypes?.[taskType] || 0;
    if (typeCount === 0) continue;
    removed += typeCount;
    bucket.count = Math.max(0, (Number(bucket.count) || 0) - typeCount);
    delete bucket.taskTypes[taskType];
    if (bucket.count <= 0 && Object.keys(bucket.taskTypes || {}).length === 0) {
      delete data.environmentalFailures[category];
    }
  }
  return removed;
}

/**
 * Reset learning data for a specific task type
 * Used when a previously-failing task type has been fixed and should be retried
 * Subtracts the task type's metrics from totals and removes the task type entry
 * @param {string} taskType - The task type to reset (e.g., 'self-improve:ui')
 * @returns {Object} Summary of what was reset
 */
export async function resetTaskTypeLearning(taskType) {
  return withLock(async () => {
  const data = await loadLearningData();

  // Purge this type from the environmental buckets FIRST (#2618): an
  // outage-only type has no byTaskType bucket, so the purge must not sit
  // behind the task-type-not-found early return below.
  //
  // Deliberately part of the RESET path, not of removeTaskTypeFromLearningData:
  // this function is "the user says this type is fixed — forget all of it", so
  // dropping its outage history is intended. A caller repairing mis-recorded
  // BUCKET data (e.g. migration 197) must not purge outages, which are recorded
  // from real errors and are true regardless of any bucket-level bug.
  const environmentalRemoved = purgeEnvironmentalFailuresForType(data, taskType);

  const metrics = data.byTaskType[taskType];
  if (!metrics) {
    if (environmentalRemoved > 0) {
      await saveLearningData(data);
      emitLog('info', `Reset environmental-only learning data for ${taskType} (${environmentalRemoved} outage events purged)`, { taskType, environmentalRemoved }, '📚 TaskLearning');
      return { reset: true, reason: 'environmental-only', taskType, environmentalRemoved };
    }
    return { reset: false, reason: 'task-type-not-found', taskType };
  }

  const previousMetrics = removeTaskTypeFromLearningData(data, taskType);

  await saveLearningData(data);

  emitLog('info', `Reset learning data for ${taskType} (was ${metrics.successRate}% success after ${metrics.completed} attempts)`, {
    taskType,
    previousSuccessRate: metrics.successRate,
    previousAttempts: metrics.completed
  }, '📚 TaskLearning');

  return { reset: true, taskType, previousMetrics };
  });
}

/**
 * Remove one task type's contribution from every learning aggregate, in place.
 * Pure (mutates `data`, no I/O) so both the runtime reset and offline repairs
 * (migrations) can share ONE definition of "what a task type contributes to" —
 * a second, hand-rolled version would silently drift as aggregates are added.
 *
 * Unwinds: `totals` (+ recomputed max/ETA), `errorPatterns`, `byModelTier` (via
 * `routingAccuracy`, which must be read BEFORE it is deleted), `routingAccuracy`,
 * `byTaskType`, `failureSignatures` (#2619), and `correlationWindow` (#2619).
 *
 * Does NOT touch `environmentalFailures` — that is a separate ledger fed only by
 * real outages, so removing it is a policy decision belonging to the caller (see
 * `resetTaskTypeLearning`, which purges it; migration 197, which must not).
 *
 * @param {Object} data - the loaded learning store, mutated in place
 * @param {string} taskType - e.g. 'self-improve:layered-intelligence'
 * @returns {{ completed:number, succeeded:number, failed:number, successRate:number }|null}
 *   the removed bucket's headline metrics, or null when the type had no bucket.
 */
export function removeTaskTypeFromLearningData(data, taskType) {
  const metrics = data?.byTaskType?.[taskType];
  if (!metrics) return null;

  // Subtract this task type's contribution from totals. Guarded because this helper
  // also runs OFFLINE against a raw on-disk store (migrations), where the defaults
  // loadLearningData applies at runtime haven't been layered on — and an aggregate
  // this function throws on would block boot rather than repair anything.
  if (data.totals && typeof data.totals === 'object') {
    data.totals.completed -= metrics.completed;
    data.totals.succeeded -= metrics.succeeded;
    data.totals.failed -= metrics.failed;
    data.totals.totalDurationMs -= metrics.totalDurationMs;
    if (data.totals.successDurationMs) {
      data.totals.successDurationMs = Math.max(0, data.totals.successDurationMs - (metrics.successDurationMs || 0));
    }
    // Recalculate max from remaining task types (we can't subtract a max)
    const remainingTypes = Object.entries(data.byTaskType).filter(([t]) => t !== taskType);
    data.totals.successMaxDurationMs = remainingTypes.reduce((max, [, m]) => Math.max(max, m.successMaxDurationMs || 0), 0);
    Object.assign(data.totals, calculateDurationETA(data.totals));
  }

  // Clean up error patterns referencing this task type
  for (const [category, pattern] of Object.entries(data.errorPatterns || {})) {
    const taskTypeCount = pattern?.taskTypes?.[taskType] || 0;
    if (taskTypeCount > 0) {
      pattern.count -= taskTypeCount;
      delete pattern.taskTypes[taskType];
    }
    // Remove empty error categories
    if (pattern.count <= 0) {
      delete data.errorPatterns[category];
    }
  }

  // Subtract model tier contributions using routing accuracy data (before deleting it)
  data.byModelTier ??= {};
  const routingData = data.routingAccuracy?.[taskType];
  if (routingData) {
    for (const [tier, counts] of Object.entries(routingData)) {
      const tierMetrics = data.byModelTier[tier];
      if (tierMetrics) {
        const tierTotal = counts.succeeded + counts.failed;
        tierMetrics.completed = Math.max(0, tierMetrics.completed - tierTotal);
        tierMetrics.succeeded = Math.max(0, tierMetrics.succeeded - counts.succeeded);
        tierMetrics.failed = Math.max(0, tierMetrics.failed - counts.failed);
        // Estimate duration contribution using task type's avg duration per agent
        if (tierTotal > 0 && metrics.avgDurationMs > 0) {
          tierMetrics.totalDurationMs = Math.max(0, tierMetrics.totalDurationMs - (metrics.avgDurationMs * tierTotal));
        }
        tierMetrics.avgDurationMs = tierMetrics.completed > 0
          ? Math.round(tierMetrics.totalDurationMs / tierMetrics.completed)
          : 0;
        // Clean up empty tiers
        if (tierMetrics.completed <= 0) {
          delete data.byModelTier[tier];
        }
      }
    }
    delete data.routingAccuracy[taskType];
  }

  // Remove the task type entry
  delete data.byTaskType[taskType];

  // Purge the task type's samples from the enriched failure signatures (#2619).
  // Each `recent[]` sample carries its `taskType` and drives
  // deriveFailureSignalAvoidance, so a leftover sample would keep steering a
  // just-reset type off a tier. Decrement each bucket's rolling count by the
  // samples removed and drop a bucket left with nothing.
  if (data.failureSignatures && typeof data.failureSignatures === 'object') {
    for (const [category, bucket] of Object.entries(data.failureSignatures)) {
      if (!Array.isArray(bucket?.recent)) continue;
      const kept = bucket.recent.filter((s) => s?.taskType !== taskType);
      const removed = bucket.recent.length - kept.length;
      if (removed === 0) continue;
      bucket.recent = kept;
      bucket.count = Math.max(0, (Number(bucket.count) || 0) - removed);
      if (bucket.recent.length === 0 && bucket.count <= 0) {
        delete data.failureSignatures[category];
      }
    }
  }

  // Drop the task type's rows from the cross-type correlation window (#2619) so a
  // rehabilitated type contributes no stale prediction/outcome pairs to the gauge.
  if (Array.isArray(data.correlationWindow)) {
    data.correlationWindow = data.correlationWindow.filter((row) => row?.taskType !== taskType);
  }

  return {
    completed: metrics.completed,
    succeeded: metrics.succeeded,
    failed: metrics.failed,
    successRate: metrics.successRate
  };
}
