/**
 * Maintenance task ladder shared by both runners.
 *
 * `MAINTENANCE_TASK_ORDER` / `MAINTENANCE_ORDER_GUIDANCE`, interleaved `MAINTENANCE_SEQUENCE_TYPES` with claim-issue drains,
 * `maintenanceStepParams`, and `buildMaintenanceSteps`, which emits quota-burn-shaped run-once steps so `quotaBurnInvoke.js` can run them from the Schedule tab or a Quota Burn plan. Pure.
 */

import { EXTENDED_AUDIT_WORKFLOW } from './auditWorkflow.js';
/*
 * One definition shared by `services/maintenanceRun.js` ("Run now") and the Quota Burn "Populate maintenance sequence" plan; the client (`client/src/lib/quotaBurnTasks.js`)
 * imports the order so banner, prerequisite check and builder cannot disagree. Between every pair of audits sits a perpetual `claim-issue` drain so findings are resolved
 * before the next audit; fix mode resolves in each audit with one final drain; issue-only runs can skip drains. The step shape is the quota-burn job shape (`quotaBurnTaskRef.js`).
 */

import { AUDIT_EXECUTION_PROFILES } from './auditCatalog.js';

/** The audits, in run order. */
export const MAINTENANCE_TASK_ORDER = Object.freeze([
  'better-structural-drift', 'simplify', 'module-hygiene', 'better-complexity',
  'performance', 'better-cognitive-load', 'documentation',
]);

export const MAINTENANCE_ORDER_GUIDANCE = 'better-structural-drift → simplify → module-hygiene → better-complexity → performance + better-cognitive-load → documentation';

/** The drain that separates every pair of audits. */
export const MAINTENANCE_DRAIN_TASK = 'claim-issue';

/** The default issue-filing ladder, including interleaved drains. */
export const MAINTENANCE_SEQUENCE_TYPES = Object.freeze(MAINTENANCE_TASK_ORDER.flatMap((type, index) =>
  (index ? [MAINTENANCE_DRAIN_TASK, type] : [type])));

// The first six audits FILE issues (the drain claims them); documentation does the work. Fix mode runs audits directly (drain once at the end). Code-producing steps request PR
// delivery explicitly so issue-only schedule defaults can't make them local-only merges. A drain pins nothing and inherits the app's saved claim filters.
export const maintenanceStepParams = (taskType, mode = 'file-issues') => (taskType === MAINTENANCE_DRAIN_TASK
  ? {}
  : mode !== 'fix' && taskType !== 'documentation'
    ? { fileIssues: true }
    : { fileIssues: false, useWorktree: true, openPR: true });

// Build the ladder as run-once steps for `appId`, pinned to the chosen provider/model/effort (`effort: null` inherits each task's saved effort). Ids are `${idPrefix}-${index}`.
// An optional claimHandler replaces the provider/model/effort bundle for drains only.
export function buildMaintenanceSteps({ appId, idPrefix, providerId = null, model = null, effort = null, mode = 'file-issues', prCompletion = null, claimBetweenAudits = true, claimHandler = null, taskTypes = null, explicitCheck = false, auditDepth = 'quick' }) {
  if (taskTypes !== null && (!Array.isArray(taskTypes) || !taskTypes.length || taskTypes.some(type => !Object.hasOwn(AUDIT_EXECUTION_PROFILES, type)))) {
    throw new Error('Quality checks must name known audit categories');
  }
  // An explicit quality selection runs only those audits, without backlog drains.
  const types = taskTypes ? [...new Set(taskTypes)] : mode === 'fix' ? [...MAINTENANCE_TASK_ORDER, MAINTENANCE_DRAIN_TASK] : claimBetweenAudits ? MAINTENANCE_SEQUENCE_TYPES : MAINTENANCE_TASK_ORDER;
  return types.map((taskType, index) => ({
    id: `${idPrefix}-${index}`,
    enabled: true,
    label: '',
    taskRef: { kind: 'builtin', taskType, appId },
    jobType: null,
    runOnce: true,
    drain: taskType === MAINTENANCE_DRAIN_TASK,
    overrides: { ...(taskType === MAINTENANCE_DRAIN_TASK && claimHandler ? claimHandler : { providerId, model, effort }), params: taskTypes ? { ...(auditDepth === 'deep' ? { auditDepth, auditWorkflow: EXTENDED_AUDIT_WORKFLOW } : {}), fileIssues: mode !== 'fix', ...(mode === 'fix' ? { useWorktree: true, openPR: true, ...(prCompletion ? { prCompletion } : {}) } : {}), ...(explicitCheck || auditDepth === 'deep' ? { runInapplicableAudit: true } : {}) } : { ...(auditDepth === 'deep' ? { auditDepth, auditWorkflow: EXTENDED_AUDIT_WORKFLOW } : {}), ...maintenanceStepParams(taskType, mode), ...(prCompletion ? { prCompletion } : {}) } },
  }));
}
