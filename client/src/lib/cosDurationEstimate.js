// Shared CoS duration/ETA estimator for the agent and task cards.
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

import { executionDurationKey, executionKeyPrefix, MIN_EXECUTION_SAMPLES } from '../../../server/lib/executionDurationKey.js';
export { EXECUTION_EFFORT_NONE, executionDurationKey, executionKeyPrefix, MIN_EXECUTION_SAMPLES } from '../../../server/lib/executionDurationKey.js';

// Rungs 3 and 4 deliberately carry no threshold here: getAllTaskDurations
// pre-filters the published task-type and overall rows at one completion.

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
