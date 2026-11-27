/** Cache the CoS queue working sets by version and persist row diffs against their original snapshots. */
import { createSingleFlight } from '../../lib/singleFlight.js';
import { planListSave, selectWorkingSet } from '../../lib/cos/cosTaskRows.js';
import { applyTaskListSave, loadTaskWorkingSet, readTaskListVersion } from './cosTaskRepository.js';

export const TASK_SOURCES = Object.freeze(['user', 'internal']);

// `getUserTasks`/`getCosTasks`/`getTaskById` run on every daemon evaluation
// tick, scheduler sweep, and agent state update. A queue's WORKING SET (every
// open task plus recently completed ones, see lib/cos/cosTaskRows.js) is loaded once
// per queue version and shared: an unchanged queue costs one single-row version
// read plus a structured clone instead of a query over the rows.
//
// Concurrent readers share the load for a version (#12225), so a cold cache does
// not multiply the working set by the number of readers. Correctness rests on:
//
//   1. The queue version, bumped by every write in the same transaction, so a
//      write this process did NOT make is noticed on the next read.
//   2. Our own writes replace the cached entry only when the version moved by
//      exactly one (nobody else wrote in between); otherwise they drop it.
const snapshotCache = new Map(); // source -> { version, snapshot }
const snapshotLoads = createSingleFlight();
// A list may be mutated or transformed before saving. Keep its ORIGINAL read
// snapshot, never a fresh read whose omissions could turn into accidental deletes.
const listSnapshots = new WeakMap();

// Store internals share snapshots: list readers clone the array,
// while ID lookups clone only the matching task. Both share invalidation.
// `rows` keeps each task's stored position for the next save's diff.
export async function readTaskSnapshot(source) {
  const version = await readTaskListVersion(source);
  const cached = snapshotCache.get(source);
  if (cached?.version === version) return cached.snapshot;
  return snapshotLoads.run(`${source}:${version}`, async () => {
    const loaded = await loadTaskWorkingSet(source);
    const snapshot = { version: loaded.version, rows: loaded.rows, tasks: loaded.rows.map((row) => row.task) };
    if (!snapshotCache.get(source) || snapshotCache.get(source).version <= loaded.version) {
      snapshotCache.set(source, { version: loaded.version, snapshot });
    }
    return snapshot;
  });
}

export async function readTaskFile(source) {
  return cloneTaskSnapshot(await readTaskSnapshot(source));
}

export function cloneTaskSnapshot(snapshot) {
  const tasks = structuredClone(snapshot.tasks);
  listSnapshots.set(tasks, snapshot);
  return tasks;
}

export async function findTaskInFile(source, taskId) {
  const snapshot = await readTaskSnapshot(source);
  if (!snapshot.byId) {
    snapshot.byId = new Map();
    for (const task of snapshot.tasks) {
      // Preserve Array.find's first-match behavior for duplicate IDs.
      if (!snapshot.byId.has(task.id)) snapshot.byId.set(task.id, task);
    }
  }
  const task = snapshot.byId.get(taskId);
  return task ? structuredClone(task) : null;
}

/**
 * Persist the queue as `tasks`: diff against the stored working set and write
 * only the rows that changed, in one transaction. Returns the committed
 * version, or false for no changes.
 */
export async function writeTaskList(source, tasks, original = tasks, dependencies = {}) {
  const snapshot = listSnapshots.get(original);
  if (!snapshot) throw new Error('Task saves require their original read snapshot');
  const cached = snapshotCache.get(source);
  const plan = planListSave({ previous: snapshot.rows, next: tasks, source });
  if (plan.upserts.length === 0 && plan.deletes.length === 0) return false;
  const version = await applyTaskListSave(source, {
    ...plan, expectedVersions: { ...dependencies, [source]: snapshot.version },
  });

  const positions = new Map(snapshot.rows.map((row) => [row.task.id, row.position]));
  for (const { task, position } of plan.upserts) positions.set(task.id, position);
  if (cached?.snapshot === snapshot && version === cached.version + 1) {
    // Same bound as a reload, so completions never accumulate in the cache.
    const rows = selectWorkingSet(plan.saved.map((task) => ({ task, position: positions.get(task.id) })));
    snapshotCache.set(source, { version, snapshot: { version, rows, tasks: rows.map((row) => row.task) } });
  } else {
    snapshotCache.delete(source);
  }
  return version;
}

/** Test hook: forget every cached working set. */
export function __resetTaskCache() {
  snapshotCache.clear();
}
