/**
 * The maintenance ladder: the ordered audits PortOS recommends running against a
 * managed app, with a perpetual `claim-issue` drain between every pair so each
 * audit's findings are resolved before the next audit reads the code. Fix mode
 * instead resolves findings in each audit and runs one final drain. Issue-only
 * runs can skip all drains to leave findings open for human review.
 *
 * ONE definition, shared by both runners. `services/maintenanceRun.js` walks
 * these steps directly for the Schedule tab's "Run now" — no quota gates, no
 * burn plan — and the Quota Burn page's "Populate maintenance sequence" saves the
 * same steps into a family plan to be walked later under that family's window
 * gates. The client (`client/src/lib/quotaBurnTasks.js`) imports the order from
 * here so the guidance banner, the prerequisite check and the server's own
 * builder cannot disagree about what the ladder is.
 *
 * Pure: no I/O, no imports out of `lib/`. The step shape is the quota-burn job
 * shape (`quotaBurnTaskRef.js`) so `quotaBurnInvoke.js` can run a step from
 * either runner without knowing which one asked.
 */

/** The audits, in the order they should run. */
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

/**
 * The run params an audit step pins. The first six audits explicitly FILE
 * issues (which the drain then claims); documentation explicitly does the work.
 * Fix mode runs audits directly and drains once at the end.
 * A drain pins nothing — it inherits the app's saved claim filters.
 */
export const maintenanceStepParams = (taskType, mode = 'file-issues') => (taskType === MAINTENANCE_DRAIN_TASK
  ? {}
  : { fileIssues: mode !== 'fix' && taskType !== 'documentation' });

/**
 * Build the ladder as run-once steps targeting `appId`, every one pinned to the
 * provider/model/effort the user chose. `effort: null` inherits each scheduled
 * task's saved effort. Ids are `${idPrefix}-${index}`, so a fresh prefix per
 * invocation yields fresh step identities.
 */
export function buildMaintenanceSteps({ appId, idPrefix, providerId = null, model = null, effort = null, mode = 'file-issues', claimBetweenAudits = true }) {
  const types = mode === 'fix' ? [...MAINTENANCE_TASK_ORDER, MAINTENANCE_DRAIN_TASK] : claimBetweenAudits ? MAINTENANCE_SEQUENCE_TYPES : MAINTENANCE_TASK_ORDER;
  return types.map((taskType, index) => ({
    id: `${idPrefix}-${index}`,
    enabled: true,
    label: '',
    taskRef: { kind: 'builtin', taskType, appId },
    jobType: null,
    runOnce: true,
    drain: taskType === MAINTENANCE_DRAIN_TASK,
    overrides: { providerId, model, effort, params: maintenanceStepParams(taskType, mode) },
  }));
}
