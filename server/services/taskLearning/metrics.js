/**
 * Task Learning — metrics aggregation
 *
 * Records completed tasks into the learning store and rebuilds derived
 * aggregates (per-tier metrics, success-only duration stats) from the
 * authoritative sources. This is the "write" side of the learning data:
 * everything here mutates and persists `learning.json`.
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  withLock,
  AGENTS_DIR,
  emitLog,
  tryReadFile,
  calculateDurationETA,
  extractTaskType,
  loadLearningData,
  saveLearningData
} from './store.js';

/**
 * Record a completed task for learning
 */
export async function recordTaskCompletion(agent, task) {
  return withLock(async () => {
  const data = await loadLearningData();

  const taskType = extractTaskType(task);
  const modelTier = agent.metadata?.modelTier || 'unknown';
  const success = agent.result?.success || false;
  const duration = agent.result?.duration || 0;
  const errorCategory = agent.result?.errorAnalysis?.category || null;

  // Initialize task type bucket if needed
  if (!data.byTaskType[taskType]) {
    data.byTaskType[taskType] = {
      completed: 0,
      succeeded: 0,
      failed: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      maxDurationMs: 0,
      p80DurationMs: 0,
      lastCompleted: null,
      successRate: 0
    };
  }

  // Initialize model tier bucket if needed
  if (!data.byModelTier[modelTier]) {
    data.byModelTier[modelTier] = {
      completed: 0,
      succeeded: 0,
      failed: 0,
      totalDurationMs: 0,
      successDurationMs: 0,
      avgDurationMs: 0
    };
  }

  // Update task type metrics
  const typeMetrics = data.byTaskType[taskType];
  typeMetrics.completed++;
  if (success) {
    typeMetrics.succeeded++;
    // Only include successful durations in ETA calculations — failed agents often
    // run long in error loops and skew estimates
    typeMetrics.successDurationMs = (typeMetrics.successDurationMs || 0) + duration;
    typeMetrics.successMaxDurationMs = Math.max(typeMetrics.successMaxDurationMs || 0, duration);
  } else {
    typeMetrics.failed++;
  }
  typeMetrics.totalDurationMs += duration;
  Object.assign(typeMetrics, calculateDurationETA(typeMetrics));
  typeMetrics.lastCompleted = new Date().toISOString();
  typeMetrics.successRate = Math.round((typeMetrics.succeeded / typeMetrics.completed) * 100);

  // Update model tier metrics
  const tierMetrics = data.byModelTier[modelTier];
  tierMetrics.completed++;
  if (success) {
    tierMetrics.succeeded++;
    tierMetrics.successDurationMs = (tierMetrics.successDurationMs || 0) + duration;
  } else {
    tierMetrics.failed++;
  }
  tierMetrics.totalDurationMs += duration;
  tierMetrics.avgDurationMs = calculateDurationETA(tierMetrics).avgDurationMs;

  // Track routing accuracy: taskType × modelTier cross-reference
  if (!data.routingAccuracy) data.routingAccuracy = {};
  if (!data.routingAccuracy[taskType]) data.routingAccuracy[taskType] = {};
  if (!data.routingAccuracy[taskType][modelTier]) {
    data.routingAccuracy[taskType][modelTier] = { succeeded: 0, failed: 0, lastAttempt: null };
  }
  const routing = data.routingAccuracy[taskType][modelTier];
  if (success) {
    routing.succeeded++;
  } else {
    routing.failed++;
  }
  routing.lastAttempt = new Date().toISOString();

  // Track error patterns
  if (!success && errorCategory) {
    if (!data.errorPatterns[errorCategory]) {
      data.errorPatterns[errorCategory] = {
        count: 0,
        taskTypes: {},
        lastOccurred: null
      };
    }
    data.errorPatterns[errorCategory].count++;
    data.errorPatterns[errorCategory].lastOccurred = new Date().toISOString();

    // Track which task types produce this error
    if (!data.errorPatterns[errorCategory].taskTypes[taskType]) {
      data.errorPatterns[errorCategory].taskTypes[taskType] = 0;
    }
    data.errorPatterns[errorCategory].taskTypes[taskType]++;

    // Store recent unknown error samples for diagnosability
    // This helps identify missing patterns that should be added to ERROR_PATTERNS
    if (errorCategory === 'unknown') {
      const errorAnalysis = agent.result?.errorAnalysis || {};
      if (!data.recentUnknownErrors) data.recentUnknownErrors = [];
      data.recentUnknownErrors.push({
        taskType,
        message: (errorAnalysis.message || '').substring(0, 200),
        details: (errorAnalysis.details || '').substring(0, 500),
        agentId: agent.agentId || agent.id,
        recordedAt: new Date().toISOString()
      });
      // Keep only last 20 samples to avoid unbounded growth
      if (data.recentUnknownErrors.length > 20) {
        data.recentUnknownErrors = data.recentUnknownErrors.slice(-20);
      }
    }
  }

  // Update totals
  data.totals.completed++;
  if (success) {
    data.totals.succeeded++;
    data.totals.successDurationMs = (data.totals.successDurationMs || 0) + duration;
    data.totals.successMaxDurationMs = Math.max(data.totals.successMaxDurationMs || 0, duration);
  } else {
    data.totals.failed++;
  }
  data.totals.totalDurationMs += duration;
  Object.assign(data.totals, calculateDurationETA(data.totals));

  await saveLearningData(data);

  emitLog('debug', `Recorded task completion: ${taskType} (${success ? 'success' : 'failed'})`, {
    taskType,
    modelTier,
    success,
    duration: Math.round(duration / 1000) + 's'
  }, '[TaskLearning]');

  return data;
  });
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

  const metrics = data.byTaskType[taskType];
  if (!metrics) {
    return { reset: false, reason: 'task-type-not-found', taskType };
  }

  // Subtract this task type's contribution from totals
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

  // Clean up error patterns referencing this task type
  for (const [category, pattern] of Object.entries(data.errorPatterns)) {
    const taskTypeCount = pattern.taskTypes[taskType] || 0;
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

  await saveLearningData(data);

  emitLog('info', `Reset learning data for ${taskType} (was ${metrics.successRate}% success after ${metrics.completed} attempts)`, {
    taskType,
    previousSuccessRate: metrics.successRate,
    previousAttempts: metrics.completed
  }, '📚 TaskLearning');

  return {
    reset: true,
    taskType,
    previousMetrics: {
      completed: metrics.completed,
      succeeded: metrics.succeeded,
      failed: metrics.failed,
      successRate: metrics.successRate
    }
  };
  });
}

/**
 * Recalculate byModelTier from routingAccuracy data.
 *
 * The byModelTier aggregate accumulates raw counts over time, including
 * historical failures from before routingAccuracy tracking existed.
 * This creates drift — e.g., the "heavy" tier can show 0% success from
 * old misconfigured runs even though recent routing data is clean.
 *
 * This function rebuilds byModelTier entirely from routingAccuracy
 * (the authoritative per-task-type per-tier source of truth) and uses
 * byTaskType average durations to estimate timing.
 *
 * Called on init to self-heal and exposed for manual triggering.
 *
 * @returns {Object} Summary of changes made
 */
export async function recalculateModelTierMetrics() {
  return withLock(async () => {
  const data = await loadLearningData();
  const routingData = data.routingAccuracy || {};
  const oldTiers = data.byModelTier || {};

  const newTiers = {};

  for (const [taskType, tiers] of Object.entries(routingData)) {
    const taskMetrics = data.byTaskType?.[taskType];
    const avgDurationPerAgent = taskMetrics?.avgDurationMs || 0;

    for (const [tier, counts] of Object.entries(tiers)) {
      const total = (counts.succeeded || 0) + (counts.failed || 0);
      if (total === 0) continue;

      if (!newTiers[tier]) {
        newTiers[tier] = {
          completed: 0,
          succeeded: 0,
          failed: 0,
          totalDurationMs: 0,
          avgDurationMs: 0
        };
      }

      newTiers[tier].completed += total;
      newTiers[tier].succeeded += counts.succeeded || 0;
      newTiers[tier].failed += counts.failed || 0;
      newTiers[tier].totalDurationMs += avgDurationPerAgent * total;
    }
  }

  // Calculate averages
  for (const metrics of Object.values(newTiers)) {
    metrics.avgDurationMs = metrics.completed > 0
      ? Math.round(metrics.totalDurationMs / metrics.completed)
      : 0;
  }

  // Build change summary
  const changes = [];
  const allTierKeys = new Set([...Object.keys(oldTiers), ...Object.keys(newTiers)]);
  for (const tier of allTierKeys) {
    const oldSuccessRate = oldTiers[tier]?.completed > 0
      ? Math.round((oldTiers[tier].succeeded / oldTiers[tier].completed) * 100)
      : null;
    const newSuccessRate = newTiers[tier]?.completed > 0
      ? Math.round((newTiers[tier].succeeded / newTiers[tier].completed) * 100)
      : null;

    if (oldSuccessRate !== newSuccessRate || oldTiers[tier]?.completed !== newTiers[tier]?.completed) {
      changes.push({
        tier,
        old: { completed: oldTiers[tier]?.completed || 0, successRate: oldSuccessRate },
        new: { completed: newTiers[tier]?.completed || 0, successRate: newSuccessRate }
      });
    }
  }

  if (changes.length > 0) {
    data.byModelTier = newTiers;
    await saveLearningData(data);

    const summary = changes.map(c =>
      `${c.tier}: ${c.old.completed}@${c.old.successRate ?? 0}% → ${c.new.completed}@${c.new.successRate ?? 0}%`
    ).join(', ');
    emitLog('info', `Recalculated model tier metrics from routing accuracy: ${summary}`, {
      changes: changes.length
    }, '📚 TaskLearning');
  }

  return { recalculated: changes.length > 0, changes };
  });
}

/**
 * Rebuild success-only duration stats from the agent archive.
 * Scans all completed agent metadata to recalculate avgDurationMs, maxDurationMs, and p80DurationMs
 * using only successful agent durations (failed agents often run long in error loops and skew ETAs).
 */
export async function recalculateDurationStats() {
  return withLock(async () => {
  const data = await loadLearningData();

  // Reset success-only duration fields
  for (const metrics of Object.values(data.byTaskType)) {
    metrics.successDurationMs = 0;
    metrics.successMaxDurationMs = 0;
  }
  data.totals.successDurationMs = 0;
  data.totals.successMaxDurationMs = 0;

  let agentCount = 0;
  let successCount = 0;

  if (existsSync(AGENTS_DIR)) {
    const dateDirs = readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name));

    // Collect all metadata paths then read in parallel
    const metaPaths = [];
    for (const dateDir of dateDirs) {
      const datePath = join(AGENTS_DIR, dateDir.name);
      const agentDirs = readdirSync(datePath, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const agentDir of agentDirs) {
        metaPaths.push(join(datePath, agentDir.name, 'metadata.json'));
      }
    }

    const results = await Promise.all(
      metaPaths.map(p => tryReadFile(p))
    );

    for (const raw of results) {
      if (!raw) continue;
      const meta = JSON.parse(raw);
      agentCount++;

      const duration = meta.result?.duration || 0;
      if (!meta.result?.success || duration <= 0) continue;

      successCount++;
      const taskType = extractTaskType({
        description: meta.metadata?.taskDescription,
        metadata: meta.metadata,
        taskType: meta.metadata?.taskType
      });

      if (data.byTaskType[taskType]) {
        data.byTaskType[taskType].successDurationMs += duration;
        data.byTaskType[taskType].successMaxDurationMs = Math.max(
          data.byTaskType[taskType].successMaxDurationMs, duration
        );
      }

      data.totals.successDurationMs += duration;
      data.totals.successMaxDurationMs = Math.max(data.totals.successMaxDurationMs, duration);
    }
  }

  // Recalculate avgDurationMs, maxDurationMs, and p80DurationMs using the helper
  for (const metrics of Object.values(data.byTaskType)) {
    if ((metrics.succeeded || 0) > 0 && metrics.successDurationMs > 0) {
      Object.assign(metrics, calculateDurationETA(metrics));
    }
  }

  if ((data.totals.succeeded || 0) > 0 && data.totals.successDurationMs > 0) {
    Object.assign(data.totals, calculateDurationETA(data.totals));
  }

  await saveLearningData(data);

  emitLog('info', `📚 Recalculated duration stats from ${agentCount} agents (${successCount} successful)`, {
    agentCount, successCount,
    newAvgMs: data.totals.avgDurationMs,
    newP80Ms: data.totals.p80DurationMs
  }, '[TaskLearning]');

  return {
    recalculated: true,
    agentsScanned: agentCount,
    successfulAgents: successCount,
    newTotals: {
      avgDurationMs: data.totals.avgDurationMs,
      p80DurationMs: data.totals.p80DurationMs,
      maxDurationMs: data.totals.maxDurationMs
    }
  };
  });
}
