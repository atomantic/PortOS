/**
 * Task Learning Service
 *
 * Tracks patterns from completed tasks to improve future task execution.
 * Learns from success/failure rates, duration patterns, and error categories
 * to provide smarter task prioritization and model selection.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cosEvents, emitLog } from './cos.js';

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

  if (!existsSync(LEARNING_FILE)) {
    return { ...DEFAULT_LEARNING_DATA };
  }

  const content = await readFile(LEARNING_FILE, 'utf-8');
  return JSON.parse(content);
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
  // Check for self-improvement type in metadata
  if (task?.metadata?.analysisType) {
    return `self-improve:${task.metadata.analysisType}`;
  }

  // Check for idle review
  if (task?.metadata?.reviewType === 'idle') {
    return 'idle-review';
  }

  // Check description patterns
  const desc = (task?.description || '').toLowerCase();

  if (desc.includes('[self-improvement]')) {
    const typeMatch = desc.match(/\[self-improvement\]\s*(\w+)/i);
    if (typeMatch) return `self-improve:${typeMatch[1]}`;
  }

  if (desc.includes('[idle review]')) {
    return 'idle-review';
  }

  if (desc.includes('[auto-fix]') || desc.includes('[auto]')) {
    return 'auto-fix';
  }

  // User task classification
  if (task?.taskType === 'user') {
    return 'user-task';
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
      modelEffectiveness
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
 */
export async function suggestModelTier(taskType) {
  const data = await loadLearningData();

  const metrics = data.byTaskType[taskType];
  if (!metrics || metrics.completed < 5) {
    return null; // Not enough data to suggest
  }

  // If success rate is low, suggest heavier model
  if (metrics.successRate < 60) {
    return {
      suggested: 'heavy',
      reason: `${taskType} has ${metrics.successRate}% success rate - heavier model may help`
    };
  }

  return null; // Current selection is working fine
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
      durations[taskType] = {
        avgDurationMs: metrics.avgDurationMs,
        avgDurationMin: Math.round(metrics.avgDurationMs / 60000),
        completed: metrics.completed,
        successRate: metrics.successRate
      };
    }
  }

  // Add overall average
  if (data.totals.completed >= 1) {
    durations._overall = {
      avgDurationMs: data.totals.avgDurationMs,
      avgDurationMin: Math.round(data.totals.avgDurationMs / 60000),
      completed: data.totals.completed,
      successRate: Math.round((data.totals.succeeded / data.totals.completed) * 100)
    };
  }

  return durations;
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
      console.error(`❌ [TaskLearning] Failed to record completion: ${err.message}`);
    });
  });

  emitLog('info', 'Task Learning System initialized', {}, '[TaskLearning]');
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

  emitLog('info', `Backfilled ${backfilled} completed tasks into learning system`, { backfilled }, '[TaskLearning]');
  return backfilled;
}
