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
//
// Rungs 3 and 4 deliberately carry NO threshold here: `getAllTaskDurations`
// already filters what it publishes, and the cards have always shown whatever
// task-type row arrived. The server's own reader applies its thresholds against
// the RAW store, which this payload is a projection of — so the mirror is the key
// composition, the cascade ORDER, and this execution-rung bar, not every gate.
const MIN_EXECUTION_SAMPLES = 3;

// A key part must be a non-empty string that cannot itself contain the separator
// (MIRRORS the server): otherwise `a|p|m|x` is both "model m at effort x" and
// "model m|x at no effort", and the rollup would match an unrelated identity.
const nonEmptyKeyPart = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && !trimmed.includes(EXECUTION_KEY_SEPARATOR) ? trimmed : null;
};

/** `taskType|providerId|model`, or null when any part is missing. Pure. */
export function executionKeyPrefix({ taskType, providerId, model } = {}) {
  const parts = [nonEmptyKeyPart(taskType), nonEmptyKeyPart(providerId), nonEmptyKeyPart(model)];
  if (parts.some((part) => part === null)) return null;
  return parts.join(EXECUTION_KEY_SEPARATOR);
}

/** `taskType|providerId|model|effort`, or null when any required part is missing. Pure. */
export function executionDurationKey({ taskType, providerId, model, effort } = {}) {
  const prefix = executionKeyPrefix({ taskType, providerId, model });
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
});

// How each rung's history is described in the cards' tooltips. The overall rung
// names no task type — it is every task type — which is why the phrase, not just
// the qualifier, lives in this table.
const BASIS_SCOPE = {
  execution: 'runs on this provider, model and effort',
  'provider-model': 'runs on this provider and model',
  'task-type': 'runs across all providers',
  overall: 'runs across all tasks',
};

/**
 * The cards' shared "Based on N completed …" clause: how much history the estimate
 * rests on, and what narrowed it. One sentence in one place, so the agent card and
 * the pending-task chip cannot describe the same estimate differently. Pure.
 */
export function describeEstimateBasis(estimate) {
  if (!estimate) return '';
  const scope = BASIS_SCOPE[estimate.basis] || BASIS_SCOPE.overall;
  const subject = estimate.basis === 'overall' ? scope : `${estimate.taskType} ${scope}`;
  return `Based on ${estimate.basedOn} completed ${subject}`;
}

/**
 * Resolve a duration estimate for one task/agent from the `/durations` payload.
 *
 * @param {Object} args
 * @param {Object|null} args.durations - the `/api/cos/learning/durations` payload
 * @param {Object|null} args.task - task-shaped input for `extractCosTaskType`
 * @param {Object|null} [args.agentMetadata] - the run's `metadata` (providerId / model / effort)
 * @returns {{estimatedMs:number, avgMs:number, basedOn:number, successRate:number|undefined,
 *   taskType:string, basis:'execution'|'provider-model'|'task-type'|'overall'}|null}
 *   null when nothing is learned yet
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
  const rollupKey = executionKeyPrefix(identity);
  const rollup = rollupKey ? durations._byExecutionProviderModel?.[rollupKey] : null;
  if (hasDuration(rollup) && rollup.completed >= MIN_EXECUTION_SAMPLES) {
    return shape(rollup, { taskType, basis: 'provider-model' });
  }

  // Rung 3 — this task type, whatever it ran on.
  const typeData = durations[taskType];
  if (hasDuration(typeData)) return shape(typeData, { taskType, basis: 'task-type' });

  // Rung 4 — the overall average.
  const overallData = durations._overall;
  if (hasDuration(overallData)) return shape(overallData, { taskType, basis: 'overall' });

  return null;
}
