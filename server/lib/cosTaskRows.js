/**
 * Row model for the CoS task queues (`cos_tasks`): the pure rules the repository
 * and the task store share, so a Postgres backend and an in-memory backend cannot
 * drift apart.
 *
 * It owns the stored form of a task (`storedForm`), the recent-completed working-set
 * rule, fractional queue `position` assignment, and `planListSave` (turn "the whole
 * list changed" into "only these rows changed").
 *
 * A task is stored in its normalized form: exactly what the retired Markdown
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
import { hasKnownPrefix, PRIORITY_VALUES, toRepresentableTask } from './taskParser.js';

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

// --- Stored form --------------------------------------------------------------
// The rules below reproduce, field by field, what writing a task as one row of the
// retired Markdown file and reading it back did (`legacyTaskMarkdown.js`); the
// property test in `cosTaskRows.storedForm.test.js` pins them to it. The row's line
// patterns captured with `(.+)$`, and `.` does not match a JS line terminator other
// than `\n` (`\r`, U+2028, U+2029), so a value or description holding one past its
// leading whitespace was lost.

const JSON_SENTINEL = '__json__:';
const ROW_ID = /^([\w-]+)\s*$/;
const METADATA_KEY = /^\s*(\w+)$/;
const VALUE_TEXT = /^\s*(.+)$/;
const FLAGGED_TAIL = /^\s*\|\s*(AUTO|APPROVAL)\s*\|\s*(.+)$/i;
const PLAIN_TAIL = /^\s*\|\s*(.+)$/;
const DROPPED = Symbol('dropped');

/**
 * The id a task is stored under: unregistered prefixes gain `task-`, trailing
 * whitespace is dropped. An id the row could not carry (any character outside
 * `[\w-]` before trailing whitespace, a newline) is refused; the old reader
 * dropped such a row, except that a `|` let it re-key the task under the id's
 * first segment and shift the rest into its priority or description. Refusing
 * that case too is the one place this is stricter than the round-trip.
 */
function storedId(id) {
  const text = `${id}`;
  const match = text.includes('\n') ? null : ROW_ID.exec(text);
  if (!match) return null;
  return hasKnownPrefix(match[1]) ? match[1] : `task-${match[1]}`;
}

/**
 * A metadata key as it reads back: leading whitespace dropped, first character
 * lower-cased (legacy Title-Case keys). Anything but a bare word is dropped; the
 * old reader re-keyed a `word: rest` key onto `word` with a mangled value, and
 * split a key with a newline into other lines; both are dropped here instead.
 */
function storedKey(key) {
  const match = key.includes('\n') ? null : METADATA_KEY.exec(key);
  if (!match) return null;
  return match[1].charAt(0).toLowerCase() + match[1].slice(1);
}

/** The text a metadata value was written as. */
function valueText(value) {
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return JSON_SENTINEL + JSON.stringify(value);
  if (typeof value !== 'string') return String(value);
  if (value.includes('\n') || value.includes('\\') || value === 'null' || value === 'undefined') {
    return JSON_SENTINEL + JSON.stringify(value);
  }
  return value;
}

/** The value that text reads back as, or DROPPED. Written text always follows `key: `. */
function readValueText(text) {
  const match = VALUE_TEXT.exec(` ${text}`);
  if (!match) return DROPPED;
  const raw = match[1].trim();
  if (raw.startsWith(JSON_SENTINEL)) {
    try {
      return JSON.parse(raw.slice(JSON_SENTINEL.length));
    } catch {
      // Not JSON after all: read it as plain text below.
    }
  }
  if (raw === 'null') return null;
  if (raw === 'undefined') return undefined;
  return raw.replace(/\\n/g, '\n');
}

/** Nullish values are dropped: an absent key already means "not set" to every reader. */
function storedMetadata(metadata) {
  const stored = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined) continue;
    const storedAs = storedKey(key);
    if (storedAs === null) continue;
    const readBack = readValueText(valueText(value));
    if (readBack !== DROPPED) stored[storedAs] = readBack;
  }
  return stored;
}

/**
 * The approval segment written before the description. The user queue writes only
 * the hold; the internal queue states `autoApproved` too (`undefined` stays flagless).
 */
function approvalSegment(task, internal) {
  if (!internal) return task.approvalRequired === true ? ' | APPROVAL' : '';
  if (task.approvalRequired || task.autoApproved === false) return ' | APPROVAL';
  return task.autoApproved !== undefined ? ' | AUTO' : '';
}

function flatDescription(task) {
  const { description } = task;
  if (typeof description !== 'string' || !/\r?\n/.test(description)) return description;
  console.warn(`⚠️ Flattened newline(s) in task ${task.id} description for single-line storage`);
  return description.replace(/\r?\n/g, ' ');
}

/**
 * The approval flags and description as they read back. A description that itself
 * opens with `AUTO |` or `APPROVAL |` is read as the flag, as the row's first line
 * pattern always did.
 */
function readHeaderTail(task, internal) {
  const tail = `${approvalSegment(task, internal)} | ${flatDescription(task)}`;
  const flagged = FLAGGED_TAIL.exec(tail);
  if (flagged) {
    const flag = flagged[1].toUpperCase();
    return { approvalRequired: flag === 'APPROVAL', autoApproved: flag === 'AUTO', description: flagged[2].trim() };
  }
  const plain = PLAIN_TAIL.exec(tail);
  return plain && { approvalRequired: false, autoApproved: true, description: plain[1].trim() };
}

/**
 * The task as it is stored and read back: a lossy-by-design normalization every
 * existing consumer expects. That includes the id: one without a registered prefix
 * reads back as `task-<id>`, so the stored id, not the incoming one, is the row key.
 */
export function storedForm(task, source) {
  const representable = toRepresentableTask(task);
  const id = storedId(representable.id);
  const header = readHeaderTail(representable, source === 'internal');
  const metadata = storedMetadata(representable.metadata);
  if (!id || !header) throw new Error(`Task ${task?.id} cannot be stored`);
  return {
    id,
    status: representable.status,
    priority: representable.priority,
    priorityValue: PRIORITY_VALUES[representable.priority],
    ...header,
    metadata,
    section: representable.status,
  };
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
