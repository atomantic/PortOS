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
