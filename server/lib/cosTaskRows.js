/**
 * Row model for the CoS task queues (`cos_tasks`): the pure rules the repository
 * and the task store share, so a Postgres backend and an in-memory backend cannot
 * drift apart.
 *
 * A task is stored in its normalized form: exactly what the old Markdown
 * round-trip produced (scalar metadata read back as strings, nullish metadata
 * dropped, one-line descriptions). Consumers were written against that shape and
 * still carry helpers (`isTruthyMeta`, ...) for it; storing anything else would
 * change their behavior as a side effect of changing the storage.
 *
 * Queue order is (status section, priority high to low, position). `position`
 * only breaks ties inside a status+priority, and is fractional so a task can be
 * inserted anywhere by taking the midpoint of its neighbours.
 */

import { isDeepStrictEqual } from 'node:util';
import { generateTasksMarkdown, parseTasksMarkdown } from './taskParser.js';

/** Completed tasks stay in the working set (what `getAllTasks()` readers see) this long... */
export const WORKING_SET_COMPLETED_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** ...and the newest this many per queue stay regardless of age. */
export const WORKING_SET_KEEP_COMPLETED = 100;
export const POSITION_STEP = 1024;
// Below this a midpoint is no longer reliably distinct; renumber the list instead.
const MIN_POSITION_GAP = 1e-6;
const STATUS_ORDER = ['pending', 'in_progress', 'challenged', 'blocked', 'completed'];

/** Section rank of a status; unknown statuses sort last, like the Markdown writer's repair bucket. */
export const statusRank = (status) => {
  const rank = STATUS_ORDER.indexOf(status);
  return rank === -1 ? STATUS_ORDER.length : rank;
};

/** When a task finished, in ms. Undated tasks (older than the stamps) count as oldest: 0. */
export function completionStamp(task) {
  const stamp = Date.parse(task?.metadata?.completedAt || task?.metadata?.updatedAt || '');
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * The task as it is stored and read back. Round-trips through the single-row
 * Markdown form: a lossy-by-design normalization every existing consumer expects.
 * That includes the id: one without a registered prefix reads back as `task-<id>`,
 * so the stored id, not the incoming one, is the row key.
 */
export function storedForm(task, source) {
  const [stored] = parseTasksMarkdown(generateTasksMarkdown([task], source === 'internal'));
  if (!stored) throw new Error(`Task ${task?.id} cannot be stored`);
  return stored;
}

/** The projection columns of a stored task. */
export function rowColumns(task) {
  const stamp = task.status === 'completed' ? completionStamp(task) : 0;
  return {
    status: task.status,
    priorityValue: Number.isFinite(task.priorityValue) ? task.priorityValue : 2,
    completedAt: stamp > 0 ? new Date(stamp).toISOString() : null,
    description: typeof task.description === 'string' ? task.description : '',
  };
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Queue order for `{ task, position }` rows. */
function compareRows(a, b) {
  return statusRank(a.task.status) - statusRank(b.task.status)
    || (b.task.priorityValue ?? 2) - (a.task.priorityValue ?? 2)
    || a.position - b.position
    || byId(a.task, b.task);
}

/**
 * The working set: every open task, completed tasks inside the recent window, and
 * the newest few completed whatever their age. Returned in queue order. The
 * Postgres backend runs the same rule in SQL; this is the in-memory one.
 */
export function selectWorkingSet(rows, { now = Date.now() } = {}) {
  const completed = rows.filter((row) => row.task.status === 'completed')
    .sort((a, b) => completionStamp(b.task) - completionStamp(a.task) || byId(b.task, a.task));
  const keptCompleted = new Set(completed.filter((row, index) => index < WORKING_SET_KEEP_COMPLETED
    || completionStamp(row.task) >= now - WORKING_SET_COMPLETED_WINDOW_MS).map((row) => row.task.id));
  return rows.filter((row) => row.task.status !== 'completed' || keptCompleted.has(row.task.id)).sort(compareRows);
}

/**
 * Which indexes of `ids` keep their stored position: the longest run whose stored
 * positions already increase in list order, so a single move rewrites a single row.
 */
function keptByLongestIncreasingRun(previous, ids) {
  const candidates = [];
  ids.forEach((id, index) => { if (previous.has(id)) candidates.push(index); });
  const tails = [];
  const link = new Array(ids.length).fill(-1);
  for (const index of candidates) {
    const position = previous.get(ids[index]);
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (previous.get(ids[tails[mid]]) < position) low = mid + 1; else high = mid;
    }
    if (low > 0) link[index] = tails[low - 1];
    tails[low] = index;
  }
  const kept = ids.map(() => false);
  for (let index = tails.at(-1) ?? -1; index !== -1; index = link[index]) kept[index] = true;
  return kept;
}

/**
 * Positions for the ids whose stored position is missing or out of order.
 * `previous` maps id -> stored position; `ids` is the new queue order. Ids that
 * still sit in increasing position order keep theirs; the rest take evenly spaced
 * values between their kept neighbours. Returns only the ids that need a write
 * (all of them when the gaps have collapsed and the list is renumbered).
 */
export function assignPositions(previous, ids) {
  const kept = keptByLongestIncreasingRun(previous, ids);

  const assigned = new Map();
  let renumber = false;
  for (let start = 0; start < ids.length;) {
    if (kept[start]) { start++; continue; }
    let end = start;
    while (end < ids.length && !kept[end]) end++;
    const count = end - start;
    const left = start > 0 ? previous.get(ids[start - 1]) : undefined;
    const right = end < ids.length ? previous.get(ids[end]) : undefined;
    let first;
    let step = POSITION_STEP;
    if (left === undefined && right === undefined) first = 0;
    else if (left === undefined) first = right - POSITION_STEP * count;
    else if (right === undefined) first = left + POSITION_STEP;
    else {
      step = (right - left) / (count + 1);
      first = left + step;
      if (step < MIN_POSITION_GAP) renumber = true;
    }
    for (let offset = 0; offset < count; offset++) assigned.set(ids[start + offset], first + step * offset);
    start = end;
  }
  if (!renumber) return assigned;
  return new Map(ids.map((id, index) => [id, index * POSITION_STEP]));
}

/**
 * What to write so the stored working set becomes `next`. `previous` is the
 * `{ task, position }` rows as loaded. Unchanged tasks are never re-normalized or
 * rewritten; a deleted id is one that left the working set's list, so rows outside
 * the working set (older completed tasks) are never touched.
 *
 * @returns {{ upserts: Array<{task: object, position: number}>, deletes: string[], saved: object[] }}
 *   `saved` is the list as it will read back, in `next` order.
 */
export function planListSave({ previous, next, source }) {
  const prior = new Map(previous.map((row) => [row.task.id, row]));

  // Keyed by the stored id (see storedForm); a repeated id keeps its first slot and its last value.
  const stored = new Map();
  const changed = new Set();
  for (const task of next) {
    const before = prior.get(task.id)?.task;
    if (before && isDeepStrictEqual(task, before)) { stored.set(task.id, before); continue; }
    const normalized = storedForm(task, source);
    const existing = prior.get(normalized.id)?.task;
    const kept = existing && isDeepStrictEqual(normalized, existing) ? existing : normalized;
    stored.set(normalized.id, kept);
    if (kept !== existing) changed.add(normalized.id);
  }
  const nextIds = [...stored.keys()];

  const positions = assignPositions(new Map(previous.map((row) => [row.task.id, row.position])), nextIds);
  const upserts = nextIds
    .filter((id) => changed.has(id) || positions.has(id))
    .map((id) => ({ task: stored.get(id), position: positions.get(id) ?? prior.get(id).position }));
  const deletes = previous.map((row) => row.task.id).filter((id) => !stored.has(id));
  return { upserts, deletes, saved: nextIds.map((id) => stored.get(id)) };
}
