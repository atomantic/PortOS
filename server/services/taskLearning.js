/**
 * Task Learning Service
 *
 * Tracks patterns from completed tasks to improve future task execution.
 * Learns from success/failure rates, duration patterns, and error categories
 * to provide smarter task prioritization and model selection.
 */

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cosEvents, emitLog } from './cos.js';
import { readJSONFile } from '../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/cos');
const LEARNING_FILE = join(DATA_DIR, 'learning.json');

/**
 * Default learning data structure
 */
const DEFAULT_LEARNING_DATA = {
  version: 1,
  lastUpdated: null,

  // Metrics by self-improvement task type
  byTaskType: {},

  // Metrics by model tier
  byModelTier: {},

  // Metrics by error category
  errorPatterns: {},

  // Routing accuracy: taskType → modelTier → { succeeded, failed }
  // Records which model tiers work/fail for each task type
  routingAccuracy: {},

  // Overall stats
  totals: {
    completed: 0,
    succeeded: 0,
    failed: 0,
    totalDurationMs: 0,
    avgDurationMs: 0
  }
};

/**
 * Load learning data from file
 */
async function loadLearningData() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }

  return readJSONFile(LEARNING_FILE, { ...DEFAULT_LEARNING_DATA });
}

/**
 * Save learning data to file
 */
async function saveLearningData(data) {
  data.lastUpdated = new Date().toISOString();
  await writeFile(LEARNING_FILE, JSON.stringify(data, null, 2));
}

/**
 * Extract task type from task description or metadata
 */
function extractTaskType(task) {
  // Check for self-improvement type in metadata (direct or forwarded from task)
  const analysisType = task?.metadata?.analysisType || task?.metadata?.taskAnalysisType;
  if (analysisType) {
    return `self-improve:${analysisType}`;
  }

  // Check for idle review
  const reviewType = task?.metadata?.reviewType || task?.metadata?.taskReviewType;
  if (reviewType === 'idle') {
    return 'idle-review';
  }

  // Check for mission tasks
  if (task?.metadata?.missionName) {
    return `mission:${task.metadata.missionName}`;
  }

  // Check for app improvement tasks
  if (task?.metadata?.taskApp && task?.metadata?.selfImprovementType) {
    return `app-improve:${task.metadata.selfImprovementType}`;
  }

  // Check description patterns
  const desc = (task?.description || '').toLowerCase();

  if (desc.includes('[self-improvement]')) {
    const typeMatch = desc.match(/\[self-improvement\]\s*([\w-]+)/i);
    if (typeMatch) return `self-improve:${typeMatch[1]}`;
    return 'self-improve:general';
  }

  if (desc.includes('[idle review]')) {
    return 'idle-review';
  }

  if (desc.includes('[auto-fix]') || desc.includes('[auto] investigate')) {
    return 'auto-fix';
  }

  if (desc.includes('[app-improvement]') || desc.includes('[app improvement]')) {
    return 'app-improvement';
  }

  // User task classification
  if (task?.taskType === 'user') {
    return 'user-task';
  }

  // Internal/system tasks that don't match a specific pattern
  if (task?.taskType === 'internal') {
    return 'internal-task';
  }

  return 'unknown';
}

/**
 * Record a completed task for learning
 */
export async function recordTaskCompletion(agent, task) {
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
      avgDurationMs: 0
    };
  }

  // Update task type metrics
  const typeMetrics = data.byTaskType[taskType];
  typeMetrics.completed++;
  if (success) {
    typeMetrics.succeeded++;
  } else {
    typeMetrics.failed++;
  }
  typeMetrics.totalDurationMs += duration;
  typeMetrics.avgDurationMs = Math.round(typeMetrics.totalDurationMs / typeMetrics.completed);
  typeMetrics.maxDurationMs = Math.max(typeMetrics.maxDurationMs || 0, duration);
  // P80 estimate: avg + 60% of the gap between avg and max
  // This provides a realistic upper-bound for progress bars so they don't hit 100% too early
  typeMetrics.p80DurationMs = Math.round(
    typeMetrics.avgDurationMs + 0.6 * (typeMetrics.maxDurationMs - typeMetrics.avgDurationMs)
  );
  typeMetrics.lastCompleted = new Date().toISOString();
  typeMetrics.successRate = Math.round((typeMetrics.succeeded / typeMetrics.completed) * 100);

  // Update model tier metrics
  const tierMetrics = data.byModelTier[modelTier];
  tierMetrics.completed++;
  if (success) {
    tierMetrics.succeeded++;
  } else {
    tierMetrics.failed++;
  }
  tierMetrics.totalDurationMs += duration;
  tierMetrics.avgDurationMs = Math.round(tierMetrics.totalDurationMs / tierMetrics.completed);

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
  } else {
    data.totals.failed++;
  }
  data.totals.totalDurationMs += duration;
  data.totals.avgDurationMs = Math.round(data.totals.totalDurationMs / data.totals.completed);
  data.totals.maxDurationMs = Math.max(data.totals.maxDurationMs || 0, duration);
  data.totals.p80DurationMs = Math.round(
    data.totals.avgDurationMs + 0.6 * ((data.totals.maxDurationMs || data.totals.avgDurationMs) - data.totals.avgDurationMs)
  );

  await saveLearningData(data);

  emitLog('debug', `Recorded task completion: ${taskType} (${success ? 'success' : 'failed'})`, {
    taskType,
    modelTier,
    success,
    duration: Math.round(duration / 1000) + 's'
  }, '[TaskLearning]');

  return data;
}

/**
 * Get learning insights for display
 */
export async function getLearningInsights() {
  const data = await loadLearningData();

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

  return {
    lastUpdated: data.lastUpdated,
    totals: {
      ...data.totals,
      successRate: overallSuccessRate,
      avgDurationMin: Math.round(data.totals.avgDurationMs / 60000)
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
      modelEffectiveness,
      recentUnknownErrors: data.recentUnknownErrors || []
    },
    recommendations: generateRecommendations(data, bestPerforming, worstPerforming, commonErrors)
  };
}

/**
 * Generate actionable recommendations based on learning data
 */
function generateRecommendations(data, bestPerforming, worstPerforming, commonErrors) {
  const recommendations = [];

  // Recommend focusing on high-success task types
  if (bestPerforming.length > 0 && bestPerforming[0].successRate >= 90) {
    recommendations.push({
      type: 'optimization',
      message: `${bestPerforming[0].type} tasks have ${bestPerforming[0].successRate}% success rate - consider increasing frequency`
    });
  }

  // Warn about low-success task types
  if (worstPerforming.length > 0 && worstPerforming[0].successRate < 50 && worstPerforming[0].completed >= 5) {
    recommendations.push({
      type: 'warning',
      message: `${worstPerforming[0].type} tasks have only ${worstPerforming[0].successRate}% success rate - may need prompt improvements`
    });
  }

  // Check for recurring errors
  if (commonErrors.length > 0 && commonErrors[0].count >= 3) {
    recommendations.push({
      type: 'action',
      message: `"${commonErrors[0].category}" errors occurred ${commonErrors[0].count} times - investigate root cause`
    });
  }

  // Check model tier usage
  const heavyTier = data.byModelTier['heavy'];
  const lightTier = data.byModelTier['light'];

  if (lightTier && lightTier.completed > 0) {
    const lightSuccessRate = Math.round((lightTier.succeeded / lightTier.completed) * 100);
    if (lightSuccessRate < 70) {
      recommendations.push({
        type: 'suggestion',
        message: `Light model (haiku) has ${lightSuccessRate}% success rate - consider routing more tasks to medium tier`
      });
    }
  }

  if (heavyTier && heavyTier.completed > 10) {
    const heavySuccessRate = Math.round((heavyTier.succeeded / heavyTier.completed) * 100);
    if (heavySuccessRate >= 95) {
      recommendations.push({
        type: 'info',
        message: `Heavy model (opus) has ${heavySuccessRate}% success rate - excellent for complex tasks`
      });
    }
  }

  return recommendations;
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
  const data = await loadLearningData();

  const metrics = data.byTaskType[taskType];
  if (!metrics || metrics.completed < 5) {
    return null; // Not enough data to suggest
  }

  // Check routing accuracy for tier-specific signals
  const routingData = data.routingAccuracy?.[taskType];
  if (routingData) {
    // Find tiers with enough data and their success rates
    const tierResults = Object.entries(routingData)
      .filter(([, r]) => (r.succeeded + r.failed) >= 3)
      .map(([tier, r]) => {
        const total = r.succeeded + r.failed;
        return { tier, successRate: Math.round((r.succeeded / total) * 100), total };
      })
      .sort((a, b) => b.successRate - a.successRate);

    // If a lighter tier has high success, no need to upgrade
    const bestTier = tierResults[0];
    if (bestTier && bestTier.successRate >= 80) {
      return {
        suggested: bestTier.tier,
        reason: `${taskType} has ${bestTier.successRate}% success with ${bestTier.tier} tier`,
        avoidTiers: tierResults.filter(t => t.successRate < 40).map(t => t.tier)
      };
    }

    // If current default tier is failing, find a better one
    const failingTiers = tierResults.filter(t => t.successRate < 40);
    if (failingTiers.length > 0) {
      const successfulTier = tierResults.find(t => t.successRate >= 60);
      return {
        suggested: successfulTier?.tier || 'heavy',
        reason: `${taskType} fails with ${failingTiers.map(t => t.tier).join(', ')} (${failingTiers.map(t => `${t.successRate}%`).join(', ')})`,
        avoidTiers: failingTiers.map(t => t.tier)
      };
    }
  }

  // Fallback: if overall success rate is low, suggest heavier model
  if (metrics.successRate < 60) {
    return {
      suggested: 'heavy',
      reason: `${taskType} has ${metrics.successRate}% success rate - heavier model may help`
    };
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
 * Record a learning insight for future reference
 * Stores observations about what works and what doesn't
 */
export async function recordLearningInsight(insight) {
  const data = await loadLearningData();

  if (!data.insights) {
    data.insights = [];
  }

  data.insights.push({
    ...insight,
    recordedAt: new Date().toISOString()
  });

  // Keep only last 50 insights
  if (data.insights.length > 50) {
    data.insights = data.insights.slice(-50);
  }

  await saveLearningData(data);
  return insight;
}

/**
 * Get recent learning insights
 */
export async function getRecentInsights(limit = 10) {
  const data = await loadLearningData();
  return (data.insights || []).slice(-limit);
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
 * Reset learning data for a specific task type
 * Used when a previously-failing task type has been fixed and should be retried
 * Subtracts the task type's metrics from totals and removes the task type entry
 * @param {string} taskType - The task type to reset (e.g., 'self-improve:ui')
 * @returns {Object} Summary of what was reset
 */
export async function resetTaskTypeLearning(taskType) {
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
  data.totals.avgDurationMs = data.totals.completed > 0
    ? Math.round(data.totals.totalDurationMs / data.totals.completed)
    : 0;
  // Recalculate max from remaining task types (we can't subtract a max)
  const remainingTypes = Object.entries(data.byTaskType).filter(([t]) => t !== taskType);
  data.totals.maxDurationMs = remainingTypes.reduce((max, [, m]) => Math.max(max, m.maxDurationMs || 0), 0);
  data.totals.p80DurationMs = data.totals.completed > 0
    ? Math.round(data.totals.avgDurationMs + 0.6 * ((data.totals.maxDurationMs || data.totals.avgDurationMs) - data.totals.avgDurationMs))
    : 0;

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
}

/**
 * Get estimated duration for a task based on historical averages
 * @param {string} taskDescription - The task description to analyze
 * @returns {Object} Duration estimate with confidence
 */
export async function getTaskDurationEstimate(taskDescription) {
  const data = await loadLearningData();

  // Extract task type from description
  const taskType = extractTaskType({ description: taskDescription });

  const metrics = data.byTaskType[taskType];

  // If we have data for this specific task type
  if (metrics && metrics.completed >= 2) {
    return {
      estimatedDurationMs: metrics.avgDurationMs,
      estimatedDurationMin: Math.round(metrics.avgDurationMs / 60000),
      p80DurationMs: metrics.p80DurationMs || metrics.avgDurationMs,
      confidence: metrics.completed >= 10 ? 'high' : metrics.completed >= 5 ? 'medium' : 'low',
      basedOn: metrics.completed,
      taskType,
      successRate: metrics.successRate
    };
  }

  // Fall back to overall average
  if (data.totals.completed >= 3) {
    return {
      estimatedDurationMs: data.totals.avgDurationMs,
      estimatedDurationMin: Math.round(data.totals.avgDurationMs / 60000),
      p80DurationMs: data.totals.p80DurationMs || data.totals.avgDurationMs,
      confidence: 'low',
      basedOn: data.totals.completed,
      taskType: 'all',
      successRate: Math.round((data.totals.succeeded / data.totals.completed) * 100)
    };
  }

  // Not enough data
  return {
    estimatedDurationMs: null,
    estimatedDurationMin: null,
    confidence: 'none',
    basedOn: 0,
    taskType: null,
    successRate: null
  };
}

/**
 * Get all task type durations for bulk lookup
 * @returns {Object} Map of task type to duration info
 */
export async function getAllTaskDurations() {
  const data = await loadLearningData();

  const durations = {};

  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    if (metrics.completed >= 1) {
      const p80 = metrics.p80DurationMs || metrics.avgDurationMs;
      durations[taskType] = {
        avgDurationMs: metrics.avgDurationMs,
        avgDurationMin: Math.round(metrics.avgDurationMs / 60000),
        p80DurationMs: p80,
        maxDurationMs: metrics.maxDurationMs || metrics.avgDurationMs,
        completed: metrics.completed,
        successRate: metrics.successRate
      };
    }
  }

  // Add overall average
  if (data.totals.completed >= 1) {
    const overallP80 = data.totals.p80DurationMs || data.totals.avgDurationMs;
    durations._overall = {
      avgDurationMs: data.totals.avgDurationMs,
      avgDurationMin: Math.round(data.totals.avgDurationMs / 60000),
      p80DurationMs: overallP80,
      maxDurationMs: data.totals.maxDurationMs || data.totals.avgDurationMs,
      completed: data.totals.completed,
      successRate: Math.round((data.totals.succeeded / data.totals.completed) * 100)
    };
  }

  return durations;
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
}

/**
 * Estimate queue completion time based on historical duration data
 * @param {Array} pendingTasks - List of pending tasks with descriptions
 * @param {number} runningCount - Number of currently running agents
 * @returns {Object} Estimate with totalMs, formatted string, and confidence
 */
export async function estimateQueueCompletion(pendingTasks = [], runningCount = 0) {
  const durations = await getAllTaskDurations();
  const overallAvg = durations._overall?.avgDurationMs || 300000; // Default 5 min

  let totalEstimateMs = 0;
  let tasksWithEstimates = 0;
  let tasksWithoutEstimates = 0;

  for (const task of pendingTasks) {
    // Try to match task type from description patterns
    const desc = (task.description || '').toLowerCase();
    let matchedDuration = null;

    // Check for specific task type patterns
    for (const [taskType, durationInfo] of Object.entries(durations)) {
      if (taskType === '_overall') continue;

      // Match by task type keywords in description
      const typeKey = taskType.replace(/^(self-improve:|app-improve:)/, '').toLowerCase();
      if (desc.includes(typeKey) || desc.includes(taskType.toLowerCase())) {
        matchedDuration = durationInfo.avgDurationMs;
        break;
      }
    }

    if (matchedDuration) {
      totalEstimateMs += matchedDuration;
      tasksWithEstimates++;
    } else {
      // Use overall average for unknown tasks
      totalEstimateMs += overallAvg;
      tasksWithoutEstimates++;
    }
  }

  // Account for currently running tasks (assume half done on average)
  if (runningCount > 0) {
    totalEstimateMs += (overallAvg * runningCount * 0.5);
  }

  // Format the estimate
  const totalMinutes = Math.round(totalEstimateMs / 60000);
  let formatted = '';
  if (totalMinutes === 0) {
    formatted = 'under 1m';
  } else if (totalMinutes < 60) {
    formatted = `~${totalMinutes}m`;
  } else {
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    formatted = mins > 0 ? `~${hours}h ${mins}m` : `~${hours}h`;
  }

  // Calculate confidence based on data quality
  const totalTasks = pendingTasks.length + runningCount;
  const confidence = totalTasks > 0
    ? Math.round((tasksWithEstimates / totalTasks) * 100)
    : 0;

  return {
    totalMs: totalEstimateMs,
    totalMinutes,
    formatted,
    taskCount: pendingTasks.length,
    runningCount,
    confidence,
    basedOnHistory: tasksWithEstimates > 0
  };
}

/**
 * Initialize learning system - listen for agent completions
 */
export function initTaskLearning() {
  cosEvents.on('agent:completed', async (agent) => {
    // Get task info from agent
    const task = {
      id: agent.taskId,
      description: agent.metadata?.taskDescription,
      taskType: agent.metadata?.taskType,
      metadata: agent.metadata
    };

    await recordTaskCompletion(agent, task).catch(err => {
      console.error(`❌ 📚 TaskLearning: Failed to record completion: ${err.message}`);
    });
  });

  // Self-heal model tier metrics on startup
  recalculateModelTierMetrics().catch(err => {
    console.error(`❌ 📚 TaskLearning: Failed to recalculate model tiers: ${err.message}`);
  });

  emitLog('info', 'Task Learning System initialized', {}, '📚 TaskLearning');
}

/**
 * Generate prompt improvement recommendations for a specific task type
 * based on error patterns and failure history.
 *
 * This helps CoS learn from its mistakes and provides actionable suggestions
 * for improving task prompts to increase success rates.
 *
 * @param {string} taskType - The task type to analyze (e.g., 'self-improve:ui-bugs')
 * @returns {Object} Recommendations object with suggestions and insights
 */
export async function getPromptImprovementRecommendations(taskType) {
  const data = await loadLearningData();
  const metrics = data.byTaskType[taskType];

  const recommendations = {
    taskType,
    hasData: !!metrics,
    successRate: metrics?.successRate || null,
    completed: metrics?.completed || 0,
    suggestions: [],
    errorInsights: [],
    promptHints: []
  };

  // Not enough data to make recommendations
  if (!metrics || metrics.completed < 3) {
    recommendations.status = 'insufficient-data';
    recommendations.message = `Only ${metrics?.completed || 0} completions - need at least 3 for recommendations`;
    return recommendations;
  }

  // Analyze error patterns specific to this task type
  const taskErrors = [];
  for (const [category, pattern] of Object.entries(data.errorPatterns)) {
    const taskTypeCount = pattern.taskTypes[taskType] || 0;
    if (taskTypeCount > 0) {
      taskErrors.push({
        category,
        count: taskTypeCount,
        percentage: Math.round((taskTypeCount / metrics.failed) * 100)
      });
    }
  }
  taskErrors.sort((a, b) => b.count - a.count);

  // Generate error-specific insights and prompt hints
  for (const error of taskErrors) {
    const insight = generateErrorInsight(error.category, error.percentage);
    if (insight) {
      recommendations.errorInsights.push(insight);
    }

    const hint = generatePromptHint(error.category, taskType);
    if (hint) {
      recommendations.promptHints.push(hint);
    }
  }

  // Generate success rate-based suggestions
  if (metrics.successRate < 30) {
    recommendations.status = 'critical';
    recommendations.suggestions.push({
      priority: 'high',
      type: 'major-revision',
      message: `Task type has only ${metrics.successRate}% success rate - prompt needs major revision`,
      action: 'Consider breaking this task into smaller, more focused subtasks'
    });
  } else if (metrics.successRate < 50) {
    recommendations.status = 'needs-improvement';
    recommendations.suggestions.push({
      priority: 'medium',
      type: 'clarification',
      message: `Success rate of ${metrics.successRate}% indicates unclear instructions`,
      action: 'Add more specific acceptance criteria and examples to the prompt'
    });
  } else if (metrics.successRate < 75) {
    recommendations.status = 'moderate';
    recommendations.suggestions.push({
      priority: 'low',
      type: 'optimization',
      message: `Success rate of ${metrics.successRate}% is acceptable but could be improved`,
      action: 'Consider adding edge case handling instructions'
    });
  } else {
    recommendations.status = 'good';
    recommendations.suggestions.push({
      priority: 'info',
      type: 'maintain',
      message: `Success rate of ${metrics.successRate}% is good - prompt is working well`,
      action: 'No changes needed, but monitor for regressions'
    });
  }

  // Duration-based suggestions
  const avgDurationMin = Math.round(metrics.avgDurationMs / 60000);
  if (avgDurationMin > 30) {
    recommendations.suggestions.push({
      priority: 'medium',
      type: 'scope',
      message: `Average duration of ${avgDurationMin} minutes is high`,
      action: 'Consider narrowing the task scope or splitting into phases'
    });
  }

  // Add general best practices based on task type category
  const generalHints = getGeneralPromptHints(taskType);
  recommendations.promptHints.push(...generalHints);

  return recommendations;
}

/**
 * Generate insight message based on error category
 */
function generateErrorInsight(category, percentage) {
  const insights = {
    'model-not-available': {
      message: `${percentage}% of failures due to model unavailability`,
      implication: 'Consider adding fallback model specification to the prompt'
    },
    'usage-limit': {
      message: `${percentage}% of failures due to API usage limits`,
      implication: 'Task may be too token-heavy; consider breaking into smaller chunks'
    },
    'rate-limit': {
      message: `${percentage}% of failures due to rate limiting`,
      implication: 'Task triggers too many API calls; add pacing instructions'
    },
    'context-length': {
      message: `${percentage}% of failures due to context length exceeded`,
      implication: 'Prompt or codebase references are too large; be more specific about which files to analyze'
    },
    'tool-error': {
      message: `${percentage}% of failures due to tool execution errors`,
      implication: 'Add explicit error handling instructions for tool usage'
    },
    'startup-failure': {
      message: `${percentage}% of failures due to agent startup failure`,
      implication: 'Agents failing immediately - check provider availability and system resources'
    },
    'turn-limit': {
      message: `${percentage}% of failures due to agent turn limit`,
      implication: 'Tasks are too large for the turn budget; break into smaller subtasks'
    },
    'billing-error': {
      message: `${percentage}% of failures due to billing/subscription issues`,
      implication: 'Provider account needs attention - check subscription status'
    },
    'unknown': {
      message: `${percentage}% of failures have unknown causes`,
      implication: 'Review agent output logs for patterns not yet categorized'
    }
  };

  return insights[category] || null;
}

/**
 * Generate prompt improvement hint based on error category and task type
 */
function generatePromptHint(category, taskType) {
  const hints = {
    'model-not-available': {
      hint: 'Add fallback model instruction',
      example: 'Use model: claude-opus-4-5-20251101 (fallback to claude-sonnet-4-20250514 if unavailable)'
    },
    'context-length': {
      hint: 'Reduce scope of file analysis',
      example: 'Focus analysis on files matching: server/services/*.js (not entire codebase)'
    },
    'tool-error': {
      hint: 'Add explicit tool usage guidance',
      example: 'If Playwright navigation fails, verify the dev server is running on port 5555'
    },
    'rate-limit': {
      hint: 'Add pacing instructions',
      example: 'Analyze routes one at a time, waiting for each to complete before proceeding'
    },
    'spawn-error': {
      hint: 'Add environment prerequisites',
      example: 'Prerequisites: Ensure npm install has been run and dev server is started'
    },
    'startup-failure': {
      hint: 'Add provider availability check',
      example: 'Before starting work, verify the AI provider responds to a simple test prompt'
    },
    'turn-limit': {
      hint: 'Reduce task scope to fit within turn budget',
      example: 'Focus on ONE specific file or component per task instead of broad analysis'
    },
    'usage-limit': {
      hint: 'Use a lighter model or reduce token consumption',
      example: 'Use targeted file reads instead of full codebase scans to reduce token usage'
    }
  };

  return hints[category] || null;
}

/**
 * Generate general prompt hints based on task type category
 */
function getGeneralPromptHints(taskType) {
  const hints = [];

  if (taskType.includes('ui-bugs') || taskType.includes('mobile') || taskType.includes('console')) {
    hints.push({
      hint: 'Add visual verification step',
      example: 'After fixing, take a new browser_snapshot to verify the fix worked'
    });
  }

  if (taskType.includes('security') || taskType.includes('audit')) {
    hints.push({
      hint: 'Add severity classification',
      example: 'Classify findings as CRITICAL/HIGH/MEDIUM/LOW and prioritize fixes accordingly'
    });
  }

  if (taskType.includes('code-quality') || taskType.includes('refactor')) {
    hints.push({
      hint: 'Add rollback safety',
      example: 'Make small, atomic commits that can be individually reverted if needed'
    });
  }

  if (taskType.includes('test')) {
    hints.push({
      hint: 'Add test verification',
      example: 'Run npm test after adding each test file to ensure it passes'
    });
  }

  if (taskType.includes('enhancement') || taskType.includes('feature')) {
    hints.push({
      hint: 'Add scope limitation',
      example: 'Implement only ONE feature per task - avoid scope creep'
    });
  }

  return hints;
}

/**
 * Get prompt improvement recommendations for all task types
 * Returns a summary suitable for display in the Learning tab
 */
export async function getAllPromptRecommendations() {
  const data = await loadLearningData();
  const allRecommendations = [];

  for (const taskType of Object.keys(data.byTaskType)) {
    const recommendations = await getPromptImprovementRecommendations(taskType);
    if (recommendations.hasData && recommendations.completed >= 3) {
      allRecommendations.push({
        taskType,
        status: recommendations.status,
        successRate: recommendations.successRate,
        completed: recommendations.completed,
        topSuggestion: recommendations.suggestions[0] || null,
        errorCount: recommendations.errorInsights.length,
        hintCount: recommendations.promptHints.length
      });
    }
  }

  // Sort by priority (critical first, then needs-improvement, etc.)
  const priorityOrder = { critical: 0, 'needs-improvement': 1, moderate: 2, good: 3, 'insufficient-data': 4 };
  allRecommendations.sort((a, b) => (priorityOrder[a.status] || 5) - (priorityOrder[b.status] || 5));

  return allRecommendations;
}

/**
 * Backfill learning data from existing completed agents
 * Call this once to populate historical data
 */
export async function backfillFromHistory() {
  const { getAgents } = await import('./cos.js');
  const agents = await getAgents();

  let backfilled = 0;
  for (const agent of agents) {
    if (agent.status === 'completed' && agent.result) {
      const task = {
        id: agent.taskId,
        description: agent.metadata?.taskDescription,
        taskType: agent.metadata?.taskType,
        metadata: agent.metadata
      };

      await recordTaskCompletion(agent, task).catch(() => {});
      backfilled++;
    }
  }

  emitLog('info', `Backfilled ${backfilled} completed tasks into learning system`, { backfilled }, '📚 TaskLearning');
  return backfilled;
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

  for (const [, metrics] of Object.entries(data.byTaskType)) {
    if (metrics.completed < 3) continue; // Insufficient data

    if (metrics.successRate >= 70) {
      healthyCount++;
    } else if (metrics.successRate >= 40) {
      warningCount++;
    } else {
      criticalCount++;
      if (metrics.completed >= 5 && metrics.successRate < 30) {
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
