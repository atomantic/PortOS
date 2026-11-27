/** Read CoS task lists, bounded queue views, and individual tasks from either source. */
import { groupTasksByStatus, getAutoApprovedTasks, getAwaitingApprovalTasks } from '../../lib/taskParser.js';
import { countCompletedTasks, getStoredTask, pageCompletedTasks } from './cosTaskRepository.js';
import { TASK_SOURCES, findTaskInFile, readTaskFile, readTaskSnapshot } from './cosTaskWorkingSet.js';

export async function getUserTasks() {
  return sourceShape('user', await readTaskFile('user'));
}

export async function getCosTasks() {
  return sourceShape('internal', await readTaskFile('internal'));
}

/**
 * Get all tasks (user + internal)
 */
export async function getAllTasks() {
  const [userTasks, cosTasks] = await Promise.all([getUserTasks(), getCosTasks()]);
  return { user: userTasks, cos: cosTasks };
}

// ── Bounded task views (#9677) ──────────────────────────────────────────────
//
// `GET /api/cos/tasks` returns the open queue plus at most one page of completed
// history, yet `getAllTasks()` structured-clones the whole working set (recent
// completed prompt bodies included) from BOTH queues first. These readers select
// from the private snapshot, or page completed history straight from the table,
// and clone only what the response carries. Nothing returned here aliases the cache.
const COMPLETED_FIRST_PAGE = 25;
const isCompleted = (task) => task.status === 'completed';

// Per-snapshot derivations, dropped with the snapshot on any version change.
function snapshotPartitions(snapshot) {
  if (!snapshot.partitions) {
    const open = [];
    const completed = [];
    for (const task of snapshot.tasks) (isCompleted(task) ? completed : open).push(task);
    snapshot.partitions = { open, completed };
  }
  return snapshot.partitions;
}

// Shape of getUserTasks()/getCosTasks() over an already-selected task subset.
// Callers pass CLONED tasks; grouped/derived lists share those clones.
function sourceShape(type, tasks) {
  const shape = { tasks, grouped: groupTasksByStatus(tasks), type };
  if (type === 'internal') {
    shape.autoApproved = getAutoApprovedTasks(tasks);
    shape.awaitingApproval = getAwaitingApprovalTasks(tasks);
  }
  return shape;
}

/**
 * One page of completed history from ONE queue, newest id first, straight from
 * the table. `nextCursor` is the last id of a full page when more remain.
 */
async function pageCompleted(type, { cursor = null, limit }) {
  const rows = await pageCompletedTasks(type, { before: cursor, limit: limit + 1 });
  const items = rows.slice(0, limit);
  return { items, total: await countCompletedTasks(type), nextCursor: rows.length > limit ? items[limit - 1].id : null };
}

/**
 * Open queue (every non-completed task, plus the `selected` historical task)
 * for both queues. `completedCount` carries the completed total.
 */
async function readQueueView(selected) {
  const read = async (type) => {
    const snapshot = await readTaskSnapshot(type);
    const { open } = snapshotPartitions(snapshot);
    const refs = selected === undefined ? open : snapshot.tasks.filter((task) => !isCompleted(task) || task.id === selected);
    const tasks = structuredClone(refs);
    // A selected historical task older than the working set is fetched by id.
    if (selected !== undefined && !refs.some((task) => task.id === selected)) {
      const stored = await getStoredTask(selected, type);
      if (stored) tasks.push(stored.task);
    }
    return { ...sourceShape(type, tasks), completedCount: await countCompletedTasks(type) };
  };
  const [user, cos] = await Promise.all([read('user'), read('internal')]);
  return { user, cos };
}

/** Open queue plus the first completed page; the rest of the history stays in the table. */
async function readBareView() {
  const read = async (type) => {
    const { open } = snapshotPartitions(await readTaskSnapshot(type));
    const page = await pageCompleted(type, { limit: COMPLETED_FIRST_PAGE });
    const shape = sourceShape(type, [...structuredClone(open), ...page.items]);
    // Completed rows leave `grouped`; only the page inside `tasks` carries them.
    return { ...shape, grouped: { ...shape.grouped, completed: [] }, completedCount: page.total, completedNextCursor: page.nextCursor };
  };
  const [user, cos] = await Promise.all([read('user'), read('internal')]);
  return { user, cos };
}

/** One page of completed history from ONE source, newest id first. */
async function readCompletedView({ source, cursor, limit }) {
  return pageCompleted(source === 'internal' ? 'internal' : 'user', { cursor, limit });
}

/**
 * Legacy limit/offset window over each queue's working set, in queue order. The
 * slice and scalar metadata only; completed history older than the working set
 * pages through the `completed` view.
 */
async function readWindowView({ offset, limit }) {
  const read = async (type) => {
    const { tasks } = await readTaskSnapshot(type);
    return { meta: { type }, tasks: structuredClone(tasks.slice(offset, offset + limit)), total: tasks.length };
  };
  const [user, cos] = await Promise.all([read('user'), read('internal')]);
  return {
    user: { ...user.meta, tasks: user.tasks },
    cos: { ...cos.meta, tasks: cos.tasks },
    totals: { user: user.total, cos: cos.total },
  };
}

/**
 * Read-only, bounded task view for the HTTP layer. `kind`:
 *   - 'queue'     { selected? } open tasks (+ the selected historical one) + completedCount
 *   - 'bare'      open tasks + first completed page (+ completedCount/completedNextCursor)
 *   - 'completed' { source, cursor?, limit } one source's page → { items, total, nextCursor }
 *   - 'window'    { offset, limit } legacy slice of the working set → { user, cos, totals }
 * Sources come back unsettled for the spawn window; `getAllTasks()` stays the raw
 * truth (the working set) for scheduler readers and `view=full`.
 */
export async function getTaskView({ kind, ...options }) {
  if (kind === 'queue') return readQueueView(options.selected);
  if (kind === 'bare') return readBareView();
  if (kind === 'completed') return readCompletedView(options);
  if (kind === 'window') return readWindowView(options);
  throw new Error(`Unknown task view: ${kind}`);
}

/**
 * Lightweight live-activity input. Derive once per queue version, so a
 * three-second poll never clones prompts or groups completed history.
 * Keep duplicates and source order, matching getAllTasks() counting semantics.
 */
export async function getPendingTaskIds() {
  const sources = await Promise.all(TASK_SOURCES.map(async (source) => {
    const snapshot = await readTaskSnapshot(source);
    snapshot.pendingIds ??= snapshot.tasks.filter(task => task.status === 'pending').map(task => task.id);
    return snapshot.pendingIds;
  }));
  // Never expose the cached arrays to callers.
  return sources.flat();
}

/**
 * Telemetry reads only diagnostics-bearing records, never full prompts or
 * grouped history. Derive per snapshot and reuse the cache's write invalidation;
 * clone the projection to keep it private.
 */
export async function getTaskDiagnostics() {
  const sources = await Promise.all(TASK_SOURCES.map(async (source) => {
    const snapshot = await readTaskSnapshot(source);
    snapshot.diagnosticTasks ??= snapshot.tasks.filter(task => {
      const diagnostics = task.metadata?.diagnostics;
      return diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics);
    }).map(task => ({
      status: task.status,
      metadata: { diagnostics: task.metadata.diagnostics, updatedAt: task.metadata.updatedAt }
    }));
    return snapshot.diagnosticTasks;
  }));
  return structuredClone(sources.flat());
}

/**
 * Approval-state view of the internal queue for pollers that need the awaiting
 * list or the auto-approved count, not the whole queue. `getCosTasks()` clones
 * every working-set prompt body to answer the same question. Derived once per
 * snapshot; only the first `limit` awaiting tasks are cloned.
 */
export async function getCosApprovalView({ limit = Infinity } = {}) {
  const snapshot = await readTaskSnapshot('internal');
  snapshot.approval ??= {
    awaiting: getAwaitingApprovalTasks(snapshot.tasks),
    autoApprovedCount: getAutoApprovedTasks(snapshot.tasks).length,
  };
  const { awaiting, autoApprovedCount } = snapshot.approval;
  return { awaitingApproval: structuredClone(awaiting.slice(0, limit)), autoApprovedCount };
}

/**
 * One task and the queue it lives in: `{ task, source: 'user' | 'internal' }`,
 * or null. The record is returned as stored (its own `taskType` intact), which
 * is what a client merging it into a list it already holds needs.
 */
export async function findTaskWithSource(taskId) {
  // Keep user-first precedence, including legacy/custom IDs. Do not infer the
  // source from a prefix or prepare grouped copies of both queues for one ID.
  const userTask = await findTaskInFile('user', taskId);
  if (userTask) return { task: userTask, source: 'user' };

  const cosTask = await findTaskInFile('internal', taskId);
  if (cosTask) return { task: cosTask, source: 'internal' };

  // Completed history older than the working set is fetched by id.
  const stored = await getStoredTask(taskId);
  return stored ? { task: stored.task, source: stored.source } : null;
}

// Legacy shape: the source overwrites the record's `taskType`. Callers that
// need the record as stored use findTaskWithSource.
export async function getTaskById(taskId) {
  const found = await findTaskWithSource(taskId);
  return found ? { ...found.task, taskType: found.source } : null;
}
