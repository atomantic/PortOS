/** Resolve stale failure blocks and orphaned investigations in version-checked batches. */
import { isInvestigationTask } from '../../lib/investigationTasks.js';
import { USER_DECISION_BLOCKED_CATEGORIES } from '../../lib/taskBlockCategories.js';
import { withStateLock } from './cosState.js';
import { cosEvents } from './cosEvents.js';
import { TASK_SOURCES, readTaskSnapshot, cloneTaskSnapshot, writeTaskList } from './cosTaskWorkingSet.js';

// After a failure storm is fixed, nothing retired what it left behind: tasks
// parked in `blocked` by a failure category, and the `[Auto] Investigate agent
// failure` tasks filed against them. They persisted indefinitely and stayed
// input to every generator/learning read. The sweep below runs on the CoS
// health tick and resolves them via STATUS FLIP (→ completed + a `resolution:
// 'auto-expired'` marker), NEVER deletion: LWW federation sync does not
// propagate deletions, so a delete just resurrects from any peer still holding
// the row.

// Default age a failure-blocked task must exceed before it is auto-expired.
export const DEFAULT_FAILURE_TASK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Max tasks the reaper flips in a single sweep — bounded so one tick can't fan
// out an unbounded burst of writes/`tasks:changed` events after a large storm.
export const DEFAULT_REAP_LIMIT = 50;

// Blocks that encode USER INTENT or an OPEN user decision are the reaper's
// exemption (`USER_DECISION_BLOCKED_CATEGORIES`, lib/taskBlockCategories.js).
// Everything else with a `blockedCategory` is a failure-path block and therefore
// reapable — including `orphan-cooldown`, which revives itself in ~30 minutes, so
// one still sitting there after 14 days IS stale.

/**
 * Age (ms) of a failure-blocked task, read from the most specific timestamp it
 * carries. Returns null when the task is not a reapable failure block, or when
 * it has no parseable timestamp — an undated block is never reaped (we can't
 * prove it is old, so leaving it is the safe default). Pure.
 */
export function blockedFailureAgeMs(task, now = Date.now()) {
  if (task?.status !== 'blocked') return null;
  const category = task.metadata?.blockedCategory;
  if (!category || USER_DECISION_BLOCKED_CATEGORIES.has(category)) return null;
  const stampedAt = task.metadata?.blockedAt
    || task.metadata?.lastFailureAt
    || task.metadata?.updatedAt;
  const t = Date.parse(stampedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}

/** True when a failure-blocked task is old enough to auto-expire. Pure. */
export function isReapableBlockedFailure(task, { now = Date.now(), maxAgeMs = DEFAULT_FAILURE_TASK_MAX_AGE_MS } = {}) {
  const age = blockedFailureAgeMs(task, now);
  return age !== null && age >= maxAgeMs;
}

/**
 * True when an investigation task's originating task(s) are all resolved —
 * absent (already reaped/deleted) or in a terminal `completed` status — so the
 * investigation no longer tracks any live failure. Requires a known originating
 * link (`metadata.affectedTasks`); a legacy investigation with no link is left
 * alone (we can't prove its cause is resolved). Pure.
 *
 * @param {object} task       the candidate investigation task
 * @param {Map}    tasksById  id → task across BOTH queues
 */
export function isReapableInvestigation(task, tasksById) {
  if (!isInvestigationTask(task)) return false;
  if (task.status === 'completed') return false; // already terminal
  // An in-progress investigation has a live agent diagnosing it; reaping it
  // would let a later finalize regress the status or spawn a second run (#12059).
  if (task.status === 'in_progress') return false;
  const affected = Array.isArray(task.metadata?.affectedTasks) ? task.metadata.affectedTasks : [];
  if (affected.length === 0) return false;
  return affected.every((id) => {
    const origin = tasksById?.get(id);
    return !origin || origin.status === 'completed';
  });
}

/**
 * Sweep resolved failure artifacts and auto-expire them via status flip (#2619).
 *
 * Two categories, both resolved to `completed` with a `resolution: 'auto-expired'`
 * marker (never deleted — federation-safe): (1) tasks parked in `blocked` by a
 * failure `blockedCategory` older than `maxAgeMs`, and (2) `[Auto] Investigate
 * agent failure` tasks whose originating task(s) are gone/completed. Bounded to
 * `limit` flips per call and single-line-logged. Runs off the health tick.
 *
 * @param {Function} prepareTaskUpdate Shared, lock-held transition builder from the task store.
 * @param {{ now?:number, maxAgeMs?:number, limit?:number }} [opts]
 * @returns {Promise<{ reaped:number, staleBlocks:number, investigations:number }>}
 */
export async function sweepFailureQueues(prepareTaskUpdate, {
  now = Date.now(),
  maxAgeMs = DEFAULT_FAILURE_TASK_MAX_AGE_MS,
  limit = DEFAULT_REAP_LIMIT
} = {}) {
  const snapshots = await readFailureSweepSnapshots();
  const tasksById = indexFailureSweepTasks(snapshots);
  const ageOptions = { now, maxAgeMs };
  const targetsBySource = { user: [], internal: [] };
  let targetCount = 0;

  for (const source of TASK_SOURCES) {
    for (const task of snapshots[source].tasks) {
      const reason = failureSweepReason(task, tasksById, ageOptions);
      if (reason) {
        targetsBySource[source].push({ task, reason });
        targetCount++;
      }
      if (targetCount >= limit) break;
    }
    if (targetCount >= limit) break;
  }

  if (targetCount === 0) return { reaped: 0, staleBlocks: 0, investigations: 0 };

  const { staleBlocks, investigations } = await withStateLock(async () => {
    const current = await readFailureSweepSnapshots();
    const changes = [];
    try {
      for (const source of TASK_SOURCES) {
        if (targetsBySource[source].length === 0) continue;
        changes.push(...await reapFailureQueue(source, targetsBySource[source], current, ageOptions, prepareTaskUpdate));
      }
      const staleBlocks = changes.filter(({ task }) => task.metadata.autoExpiredReason === 'stale-failure-block').length;
      return { staleBlocks, investigations: changes.length - staleBlocks };
    } finally {
      // Publish every committed change even if the other queue's write fails.
      for (const change of changes) cosEvents.emit('tasks:changed', change);
    }
  });

  const reaped = staleBlocks + investigations;
  if (reaped > 0) {
    console.log(`🧹 Reaped ${reaped} resolved failure task(s): ${staleBlocks} stale block(s), ${investigations} investigation(s)`);
  }
  return { reaped, staleBlocks, investigations };
}

async function readFailureSweepSnapshots() {
  const [user, internal] = await Promise.all(TASK_SOURCES.map(readTaskSnapshot));
  return { user, internal };
}

function indexFailureSweepTasks(snapshots) {
  const tasksById = new Map();
  for (const source of TASK_SOURCES) {
    for (const task of snapshots[source].tasks) tasksById.set(task.id, task);
  }
  return tasksById;
}

function failureSweepReason(task, tasksById, ageOptions) {
  if (isReapableBlockedFailure(task, ageOptions)) return 'stale-failure-block';
  return isReapableInvestigation(task, tasksById) ? 'investigation-resolved' : null;
}

async function reapFailureQueue(source, targets, snapshots, ageOptions, prepareTaskUpdate) {
  const tasks = cloneTaskSnapshot(snapshots[source]);
  const indexes = new Map(tasks.map((task, index) => [task.id, index]));
  const tasksById = indexFailureSweepTasks({ ...snapshots, [source]: { tasks } });
  const changes = [];
  const dependencies = {};

  for (const { task, reason } of targets) {
    const index = indexes.get(task.id);
    const current = tasks[index];
    if (!current || failureSweepReason(current, tasksById, ageOptions) !== reason) continue;
    const { change } = await prepareTaskUpdate(current, {
      status: 'completed',
      metadata: { resolution: 'auto-expired', autoExpiredReason: reason, autoExpiredAt: new Date(ageOptions.now).toISOString() }
    }, source, {
      now: ageOptions.now,
      expectedStatus: task.status,
      // A revived task can fail again before this write and return to blocked.
      // Preserve the category and every age fallback that justified this sweep.
      expectedMetadata: reason === 'stale-failure-block' ? {
        blockedCategory: task.metadata?.blockedCategory,
        blockedAt: task.metadata?.blockedAt,
        lastFailureAt: task.metadata?.lastFailureAt,
        updatedAt: task.metadata?.updatedAt,
      } : null,
    });
    if (!change) continue;

    tasks[index] = change.task;
    if (tasksById.get(task.id) === current) tasksById.set(task.id, change.task);
    changes.push(change);
    if (reason === 'investigation-resolved') {
      // An origin can be resumed in either queue by a different process. Pin
      // both versions through commit, even between the two writes (#12059).
      const other = source === 'user' ? 'internal' : 'user';
      dependencies[other] = snapshots[other].version;
    }
  }

  if (changes.length === 0) return changes;
  const version = await writeTaskList(source, tasks, tasks, dependencies).catch(error => {
    if (error.code !== 'COS_TASK_LIST_CONFLICT') throw error;
    return false; // The next health tick can reconsider the changed queue.
  });
  if (version === false) return [];

  snapshots[source] = { version, tasks };
  return changes;
}
