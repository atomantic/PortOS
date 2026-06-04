/**
 * Task Learning — duration estimation
 *
 * Read-only duration lookups used for ETA display and queue-completion
 * estimates. Derived entirely from the persisted byTaskType / totals
 * duration stats produced by the metrics module.
 */

import { loadLearningData, extractTaskType } from './store.js';

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
