/**
 * Task Learning — duration estimation
 *
 * Read-only duration lookups used for ETA display and queue-completion
 * estimates. Derived entirely from the persisted byTaskType / byTaskTypeExecution
 * / totals duration stats produced by the metrics module.
 */

import {
  loadLearningData,
  extractTaskType,
  calculateDurationETA,
  executionDurationKey,
  executionKeyPrefix,
  executionKeyMatchesPrefix
} from './store.js';

// Minimum completions before an execution-scoped bucket (issue #8001) is trusted
// over the broader task-type average. Higher than the task-type bar (2) on
// purpose: this dimension is far more granular, so one or two samples of a
// specific provider/model/effort say less than a rich task-type history does.
const MIN_EXECUTION_SAMPLES = 3;
const MIN_TASK_TYPE_SAMPLES = 2;
const MIN_OVERALL_SAMPLES = 3;

const confidenceFor = (completed) => (completed >= 10 ? 'high' : completed >= 5 ? 'medium' : 'low');

/**
 * Sum a set of execution buckets into one aggregate, re-deriving the ETA stats
 * from the RAW success totals via `calculateDurationETA` rather than averaging
 * already-averaged numbers (which would weight a 1-run bucket like a 50-run one).
 * Pure. Returns null when the set is empty.
 *
 * Shared by the rung-2 lookup below and the `_byExecutionProviderModel` rollup
 * `getAllTaskDurations` publishes, so the server's own reader and the payload the
 * client estimates from cannot drift.
 */
export function aggregateExecutionBuckets(buckets) {
  const list = (buckets || []).filter(Boolean);
  if (list.length === 0) return null;
  const agg = list.reduce((acc, m) => ({
    completed: acc.completed + (m.completed || 0),
    succeeded: acc.succeeded + (m.succeeded || 0),
    failed: acc.failed + (m.failed || 0),
    totalDurationMs: acc.totalDurationMs + (m.totalDurationMs || 0),
    successDurationMs: acc.successDurationMs + (m.successDurationMs || 0),
    successMaxDurationMs: Math.max(acc.successMaxDurationMs, m.successMaxDurationMs || 0)
  }), { completed: 0, succeeded: 0, failed: 0, totalDurationMs: 0, successDurationMs: 0, successMaxDurationMs: 0 });
  Object.assign(agg, calculateDurationETA(agg));
  agg.successRate = agg.completed > 0 ? Math.round((agg.succeeded / agg.completed) * 100) : 0;
  return agg;
}

/** Shape one metrics bucket as a duration estimate. Pure. */
function toEstimate(metrics, { taskType, basis }) {
  return {
    estimatedDurationMs: metrics.avgDurationMs,
    estimatedDurationMin: Math.round(metrics.avgDurationMs / 60000),
    p80DurationMs: metrics.p80DurationMs || metrics.avgDurationMs,
    confidence: confidenceFor(metrics.completed),
    basedOn: metrics.completed,
    taskType,
    basis,
    successRate: metrics.successRate
  };
}

/** The bulk-payload projection of one bucket. Pure. */
function toDurationRow(metrics) {
  return {
    avgDurationMs: metrics.avgDurationMs,
    avgDurationMin: Math.round(metrics.avgDurationMs / 60000),
    p80DurationMs: metrics.p80DurationMs || metrics.avgDurationMs,
    maxDurationMs: metrics.maxDurationMs || metrics.avgDurationMs,
    completed: metrics.completed,
    successRate: metrics.successRate
  };
}

/**
 * Get estimated duration for a task based on historical averages.
 *
 * Answers from the NARROWEST bucket that has enough evidence, cascading outward
 * (issue #8001): the exact provider/model/effort this run uses → the same
 * provider+model at any effort → the task type → the overall average. The run's
 * execution identity is the largest single driver of wall-clock time, so a
 * release check on a slow local model and the same check on a fast cloud model
 * stop sharing one meaningless average.
 *
 * `basis` names which rung answered, so the UI can say what it estimated from.
 *
 * @param {string} taskDescription - The task description to analyze
 * @param {{ providerId?: string, model?: string, effort?: string|null }} [execution]
 *   The run's concrete execution identity. Omitted (a legacy string-only call)
 *   skips both execution rungs and behaves exactly as this function always has.
 * @returns {Object} Duration estimate with confidence and basis
 */
export async function getTaskDurationEstimate(taskDescription, { providerId, model, effort } = {}) {
  const data = await loadLearningData();

  // Extract task type from description
  const taskType = extractTaskType({ description: taskDescription });
  const executionBuckets = data.byTaskTypeExecution || {};

  // Rung 1 — this exact provider/model/effort.
  const exactKey = executionDurationKey({ taskType, providerId, model, effort });
  const exact = exactKey ? executionBuckets[exactKey] : null;
  if (exact && exact.completed >= MIN_EXECUTION_SAMPLES) {
    return toEstimate(exact, { taskType, basis: 'execution' });
  }

  // Rung 2 — same provider+model, summed across every effort level. A model's
  // throughput dominates the estimate; effort refines it. So once effort has too
  // little history of its own, the provider+model history is still far sharper
  // than lumping every provider's runs of this task type together.
  const prefix = executionKeyPrefix({ taskType, providerId, model });
  if (prefix) {
    const providerModel = aggregateExecutionBuckets(
      Object.entries(executionBuckets)
        .filter(([key]) => executionKeyMatchesPrefix(key, prefix))
        .map(([, metrics]) => metrics)
    );
    if (providerModel && providerModel.completed >= MIN_EXECUTION_SAMPLES) {
      return toEstimate(providerModel, { taskType, basis: 'provider-model' });
    }
  }

  // Rung 3 — data for this specific task type, whatever it ran on.
  const metrics = data.byTaskType[taskType];
  if (metrics && metrics.completed >= MIN_TASK_TYPE_SAMPLES) {
    return toEstimate(metrics, { taskType, basis: 'task-type' });
  }

  // Rung 4 — fall back to overall average
  if (data.totals.completed >= MIN_OVERALL_SAMPLES) {
    return {
      estimatedDurationMs: data.totals.avgDurationMs,
      estimatedDurationMin: Math.round(data.totals.avgDurationMs / 60000),
      p80DurationMs: data.totals.p80DurationMs || data.totals.avgDurationMs,
      confidence: 'low',
      basedOn: data.totals.completed,
      taskType: 'all',
      basis: 'overall',
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
    basis: null,
    successRate: null
  };
}

/**
 * Get all task type durations for bulk lookup.
 *
 * Task types stay TOP-LEVEL entries so the response shape is backward compatible;
 * the aggregates that are not task types ride under reserved `_`-prefixed keys
 * (`_overall`, plus the execution dimension's `_byExecution` /
 * `_byExecutionProviderModel` from issue #8001). Every consumer that enumerates
 * task types must skip reserved keys, not just `_overall`.
 *
 * @returns {Object} Map of task type to duration info
 */
export async function getAllTaskDurations() {
  const data = await loadLearningData();

  const durations = {};

  for (const [taskType, metrics] of Object.entries(data.byTaskType)) {
    if (metrics.completed >= 1) {
      durations[taskType] = toDurationRow(metrics);
    }
  }

  // Add overall average
  if (data.totals.completed >= 1) {
    durations._overall = toDurationRow({
      ...data.totals,
      maxDurationMs: data.totals.maxDurationMs || data.totals.avgDurationMs,
      successRate: Math.round((data.totals.succeeded / data.totals.completed) * 100)
    });
  }

  // Execution-scoped buckets (issue #8001), keyed by `executionDurationKey`, plus
  // the provider+model rollup across effort levels. The rollup is published rather
  // than left to the client: it is summed from the RAW success totals through the
  // same `calculateDurationETA` the server's own cascade uses, so the client
  // estimator is a pure lookup and cannot re-derive the ETA math differently.
  const executionBuckets = data.byTaskTypeExecution || {};
  const byExecution = {};
  const providerModelGroups = new Map();
  for (const [key, metrics] of Object.entries(executionBuckets)) {
    if (!metrics || (metrics.completed || 0) < 1) continue;
    byExecution[key] = toDurationRow(metrics);
    // The key is `taskType|providerId|model|effort` — everything but the effort
    // segment is the rollup identity.
    const prefix = key.slice(0, key.lastIndexOf('|'));
    if (!prefix) continue;
    if (!providerModelGroups.has(prefix)) providerModelGroups.set(prefix, []);
    providerModelGroups.get(prefix).push(metrics);
  }
  // Published only when there is something in them, the same discipline `_overall`
  // follows — an install with no learned history still answers a bare `{}`.
  if (Object.keys(byExecution).length > 0) {
    durations._byExecution = byExecution;
    durations._byExecutionProviderModel = Object.fromEntries(
      [...providerModelGroups].map(([prefix, buckets]) => [prefix, toDurationRow(aggregateExecutionBuckets(buckets))])
    );
  }

  return durations;
}
