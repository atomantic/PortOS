/**
 * The CoS task vocabularies and the task-shape rules every store boundary shares: id prefixes, status/priority values, and the repair of an unrepresentable task.
 *
 * `TASK_STATUS_VALUES` / `TASK_PRIORITY_VALUES` are read by `cosValidation.js` and
 * `peerSyncValidation.js` so the HTTP and wire enums cannot drift from the store.
 * `UNKNOWN_STATUS_BLOCKED_CATEGORY` is the marker `toRepresentableTask` stamps when it
 * REPAIRS an unrepresentable task instead of dropping its row (#7239).
 *
 * The retired Markdown task-file format lives in `legacyTaskMarkdown.js`, which only
 * db-migration 018 and tests import (#16407).
 */

// Canonical prefix lists — add new prefixes here, not in scattered startsWith checks.
//
// REGISTERING A PREFIX IS MANDATORY: an id whose prefix is absent here is
// rewritten to `task-<id>` on the next read, so the producer can no longer
// address its record (and the queue may see a SECOND task). Those best-effort
// reads and writes miss SILENTLY.
const INTERNAL_PREFIXES = ['sys-', 'app-improve-', 'cd-', 'preflight-', 'self-improve-', 'fa-run-'];
const ALL_KNOWN_PREFIXES = ['task-', ...INTERNAL_PREFIXES];

export const hasKnownPrefix = (id) => ALL_KNOWN_PREFIXES.some(p => id?.startsWith(p));
export const isInternalTaskId = (id) => INTERNAL_PREFIXES.some(p => id?.startsWith(p));

/**
 * The canonical task vocabularies, owned here so nothing can re-declare a drifting
 * copy. A status or priority outside them cannot be queued: `toRepresentableTask`
 * repairs it. Validate against these at every boundary that can set a status or
 * priority (cosValidation.js, peerSyncValidation.js).
 */
export const TASK_STATUS_VALUES = Object.freeze(['pending', 'in_progress', 'completed', 'blocked', 'challenged']);

export const PRIORITY_VALUES = {
  'CRITICAL': 4,
  'HIGH': 3,
  'MEDIUM': 2,
  'LOW': 1
};

export const TASK_PRIORITY_VALUES = Object.freeze(Object.keys(PRIORITY_VALUES));

/**
 * The `blockedCategory` stamped on a task whose status was outside
 * TASK_STATUS_VALUES when the file was written. The task is parked rather than
 * dropped, and its original status is preserved in `metadata.unrepresentableStatus`
 * so a human (or a later migration) can resolve what it should have been.
 */
export const UNKNOWN_STATUS_BLOCKED_CATEGORY = 'unknown-status';

const REPAIRED_STATUS = 'blocked';
const REPAIRED_PRIORITY = 'MEDIUM';

/**
 * Write-side backstop: return a task the queue can actually represent.
 *
 * Coerce rather than throw: a task with an out-of-vocabulary value is repaired,
 * since a row that cannot be written is silently deleted.
 *
 * Never mutates its argument; a representable task is returned as-is. Exported
 * because the constructors (`cosTaskIntake.buildQueuedTask`,
 * `cosTaskStore.updateTask`) run it so what they emit matches what is stored.
 */
export function toRepresentableTask(task) {
  const statusOk = TASK_STATUS_VALUES.includes(task?.status);
  const priorityOk = TASK_PRIORITY_VALUES.includes(task?.priority);
  if (statusOk && priorityOk) return task;

  const repairs = [];
  if (!statusOk) repairs.push(`status \`${String(task?.status)}\` -> ${REPAIRED_STATUS}`);
  if (!priorityOk) repairs.push(`priority \`${String(task?.priority)}\` -> ${REPAIRED_PRIORITY}`);
  console.warn(`⚠️ Task ${task?.id} is not representable in the task format; repairing ${repairs.join(', ')}`);

  return {
    ...task,
    status: statusOk ? task.status : REPAIRED_STATUS,
    priority: priorityOk ? task.priority : REPAIRED_PRIORITY,
    priorityValue: priorityOk ? task.priorityValue : PRIORITY_VALUES[REPAIRED_PRIORITY],
    // A status repair ALWAYS stamps `unknown-status`: a prior category describes
    // some earlier block, and a reapable one would let the 14-day auto-expiry
    // complete the rescued task (see taskBlockCategories.js). The old value is kept.
    metadata: statusOk ? (task.metadata || {}) : {
      ...task?.metadata,
      ...(task?.metadata?.blockedCategory ? { priorBlockedCategory: task.metadata.blockedCategory } : {}),
      blockedCategory: UNKNOWN_STATUS_BLOCKED_CATEGORY,
      unrepresentableStatus: String(task?.status)
    }
  };
}

/**
 * Group tasks by status
 */
export function groupTasksByStatus(tasks) {
  return {
    pending: tasks.filter(t => t.status === 'pending'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    challenged: tasks.filter(t => t.status === 'challenged'),
    blocked: tasks.filter(t => t.status === 'blocked'),
    completed: tasks.filter(t => t.status === 'completed')
  };
}

/**
 * Filter tasks that can be auto-executed
 */
export function getAutoApprovedTasks(tasks) {
  return tasks.filter(t => t.autoApproved && !t.approvalRequired && t.status === 'pending');
}

/**
 * Filter tasks awaiting user approval
 */
export function getAwaitingApprovalTasks(tasks) {
  return tasks.filter(t => t.approvalRequired && t.status === 'pending');
}
