// Shared CoS duration/ETA estimator for the agent and task cards.
//
// MIRROR: keep the key composition aligned with server/services/taskLearning/store.js's
// `executionDurationKey()` / `executionKeyPrefix()`. The server owns the buckets;
// composing the same key here is what attaches a card's ETA to the historical runs
// that produced it — the same discipline `cosTaskType.js` follows for the task type.
//
// The cascade answers from the NARROWEST bucket with enough evidence, mirroring the
// server's `getTaskDurationEstimate` (#8001):
//   1. execution      — this task type on THIS provider + model + effort
//   2. provider-model — same provider + model, any effort
//   3. task-type      — today's behavior
//   4. overall        — today's fallback
//
// The run's provider/model/effort is the largest single driver of wall-clock time, so
// a release check on a slow local model and the same check on a fast cloud model stop
// sharing one average that is wrong for both.
//
// No ETA arithmetic lives here: `/api/cos/learning/durations` publishes the per-effort
// buckets AND the provider+model rollup already summed through the server's own
// `calculateDurationETA`, so every rung below is a pure lookup.

import { extractCosTaskType } from './cosTaskType.js';

// Effort sentinel for a provider with no effort control — MIRRORS the server's
// EXECUTION_EFFORT_NONE. Absent effort is its own bucket, never a key ending in a
// bare separator that both `''` and `undefined` would collapse into.
export const EXECUTION_EFFORT_NONE = 'default';

const EXECUTION_KEY_SEPARATOR = '|';

// Minimum completions before an execution-scoped bucket outranks the broader
// task-type average — MIRRORS the server's MIN_EXECUTION_SAMPLES. One run of a
// specific provider/model/effort says less than a rich task-type history does.
export const MIN_EXECUTION_SAMPLES = 3;

const nonEmptyKeyPart = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** `taskType|providerId|model`, or null when any part is missing. Pure. */
export function executionProviderModelKey({ taskType, providerId, model } = {}) {
  const parts = [nonEmptyKeyPart(taskType), nonEmptyKeyPart(providerId), nonEmptyKeyPart(model)];
  if (parts.some((part) => part === null)) return null;
  return parts.join(EXECUTION_KEY_SEPARATOR);
}

/** `taskType|providerId|model|effort`, or null when any required part is missing. Pure. */
export function executionDurationKey({ taskType, providerId, model, effort } = {}) {
  const prefix = executionProviderModelKey({ taskType, providerId, model });
  if (prefix === null) return null;
  return `${prefix}${EXECUTION_KEY_SEPARATOR}${nonEmptyKeyPart(effort) ?? EXECUTION_EFFORT_NONE}`;
}

const hasDuration = (row) => !!row && !!row.avgDurationMs;

const shape = (row, { taskType, basis }) => ({
  estimatedMs: row.p80DurationMs || row.avgDurationMs,
  avgMs: row.avgDurationMs,
  basedOn: row.completed,
  successRate: row.successRate,
  taskType,
  basis,
  // Kept for the existing call sites: true for anything sharper than the
  // all-tasks average, which is what the cards gate their per-type chips on.
  isTypeSpecific: basis !== 'overall',
});

const BASIS_SCOPE = {
  execution: 'runs on this provider, model and effort',
  'provider-model': 'runs on this provider and model',
  'task-type': 'runs across all providers',
};

/**
 * Human-readable phrase for the history an estimate was drawn from, for the
 * cards' tooltips: which task type, and what NARROWED it. Reads as the object of
 * "Based on N completed …", so the user can tell an execution-specific estimate
 * from one averaged over every provider. Pure.
 */
export function describeEstimateScope(estimate) {
  if (!estimate) return '';
  const scope = BASIS_SCOPE[estimate.basis];
  return scope ? `${estimate.taskType} ${scope}` : 'runs across all tasks';
}

/**
 * Resolve a duration estimate for one task/agent from the `/durations` payload.
 *
 * @param {Object} args
 * @param {Object|null} args.durations - the `/api/cos/learning/durations` payload
 * @param {Object|null} args.task - task-shaped input for `extractCosTaskType`
 * @param {Object|null} [args.agentMetadata] - the run's `metadata` (providerId / model / effort)
 * @returns {{estimatedMs:number, avgMs:number, basedOn:number, successRate:number|undefined,
 *   taskType:string, basis:string, isTypeSpecific:boolean}|null} null when nothing is learned yet
 */
export function estimateCosDuration({ durations, task, agentMetadata = null } = {}) {
  if (!durations) return null;

  const taskType = extractCosTaskType(task);
  const identity = {
    taskType,
    providerId: agentMetadata?.providerId,
    model: agentMetadata?.model,
    // `?? null` (not `||`): a provider with no effort control reports a genuinely
    // absent effort, which the key builder maps to its own sentinel.
    effort: agentMetadata?.effort ?? null,
  };

  // Rung 1 — this exact provider/model/effort.
  const exactKey = executionDurationKey(identity);
  const exact = exactKey ? durations._byExecution?.[exactKey] : null;
  if (hasDuration(exact) && exact.completed >= MIN_EXECUTION_SAMPLES) {
    return shape(exact, { taskType, basis: 'execution' });
  }

  // Rung 2 — same provider + model, summed across effort levels by the server.
  const rollupKey = executionProviderModelKey(identity);
  const rollup = rollupKey ? durations._byExecutionProviderModel?.[rollupKey] : null;
  if (hasDuration(rollup) && rollup.completed >= MIN_EXECUTION_SAMPLES) {
    return shape(rollup, { taskType, basis: 'provider-model' });
  }

  // Rung 3 — this task type, whatever it ran on.
  const typeData = durations[taskType];
  if (hasDuration(typeData)) return shape(typeData, { taskType, basis: 'task-type' });

  // Rung 4 — the overall average.
  const overallData = durations._overall;
  if (hasDuration(overallData)) return shape(overallData, { taskType: 'all tasks', basis: 'overall' });

  return null;
}
