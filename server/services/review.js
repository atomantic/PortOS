/**
 * Review Hub Service
 *
 * Manages review items: todos, alerts, briefing notes, and CoS action requests.
 * Aggregates items requiring user attention into a single hub.
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { EventEmitter } from 'events';
import { ensureDir, PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPaginationRequested, paginateArray } from '../lib/queryValidation.js';
import { cosEvents } from './cos/cosEvents.js';
import { GOAL_FIDELITY_HOLD_EVENT, formatGoalFidelitySummary } from '../lib/goalFidelity.js';

const SOURCE_OWNED_REVIEW_CATEGORIES = new Set([
  'content-review',
  'goal-fidelity',
  'memory-approval',
  'plan-question',
  'task-approval',
  'autopilot-paused',
]);

const toText = (value) => (typeof value === 'string' ? value.trim() : '');

const toReference = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return toText(value);
};

/**
 * Source-owned obligations must be completed by their owning action, not by
 * the generic Review service. Keep this classifier beside the policy it
 * protects so review.js does not eagerly load the queue's notification
 * adapters and their vocabulary for every caller that only needs review
 * storage.
 */
export const isSourceOwnedReviewItem = (item) => {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const category = toText(metadata.category);

  if (metadata.sourceOwned === true || metadata.triageOnly === true) return true;
  if (SOURCE_OWNED_REVIEW_CATEGORIES.has(category)) return true;
  if (item?.type === 'cos' && (toReference(metadata.taskId) || toReference(metadata.referenceId))) {
    return true;
  }
  return item?.type === 'alert';
};

const DATA_DIR = join(PATHS.data, 'review');
const ITEMS_FILE = join(DATA_DIR, 'items.json');
// Cold storage for completed/dismissed items retention moves out of items.json
// (see `applyRetention` below) — same file-backed record kind, split by age,
// inside the existing `data/review/` directory rather than a new data store.
const ARCHIVE_FILE = join(DATA_DIR, 'archive.json');

export const reviewEvents = new EventEmitter();

// One write tail for BOTH items.json and archive.json: `reopenItem` and
// `applyRetention` mutate the pair together, and `atomicWrite` only prevents a
// torn file — it does not stop two overlapping load -> mutate -> save turns
// from replacing each other's change (#10911). Every mutator runs its whole
// read-modify-write region through `runMutation`.
const queueWrite = createFileWriteQueue();

/**
 * Run a load -> mutate -> save region serialized against every other review
 * mutation, then emit its events AFTER the queue turn has released. The region
 * returns `{ result, events }` where `events` is a list of `[name, payload]`.
 * Emitting outside the critical section keeps a `reviewEvents` listener that
 * calls a mutator synchronously from re-entering (and deadlocking on) the
 * queue it is still holding. Regions must never await another queued mutator.
 */
async function runMutation(region) {
  const { result, events = [] } = await queueWrite(region);
  for (const [name, payload] of events) reviewEvents.emit(name, payload);
  return result;
}

// Valid item types and statuses
const ITEM_TYPES = ['alert', 'todo', 'briefing', 'cos'];
const ITEM_STATUSES = ['pending', 'completed', 'dismissed'];

// Retention: on a daily debounce, move completed/dismissed items older than
// this out of items.json and into archive.json (see `applyRetention`).
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_ELIGIBLE_STATUSES = new Set(['completed', 'dismissed']);

// Module-level caches of parsed Review files, keyed on file identity (mtime +
// size) rather than an in-process "loaded" flag: `dataManager.js` registers
// `review` as archivable, so `data/review/` can still be replaced out from
// under this process while it runs (restore, or a manual delete), and a flag-based cache
// would keep serving a since-deleted file's contents forever. Writes invalidate
// the cache instead of seeding it from what they wrote: writes are serialized by `runMutation`, but unqueued reads (`getItems`,
// `getPendingCounts`) can still overlap a write, and a post-write stat could
// pin one writer's content under another turn's identity and serve it until
// the next write. Invalidation keeps the invariant simple —
// the cache only ever holds content read from the file under its own identity
// — at the cost of one re-parse per write.
//
// Snapshots are read-only inside this module. Mutations and public read results
// copy the records they expose so callers cannot change a later read or save.
let itemsCache = null; // { mtimeMs, size, items }
let archiveCache = null;
let archiveRead = null;
let lastRetentionAt = 0; // 0 so the first save after boot always evaluates retention

const statReviewFile = (file) => stat(file).catch((err) => {
  if (err.code === 'ENOENT') return null;
  throw err;
});

const matchesFileIdentity = (stats, cache) =>
  stats && cache && stats.mtimeMs === cache.mtimeMs && stats.size === cache.size;

const reviewSnapshot = (stats, items) => stats ? { mtimeMs: stats.mtimeMs, size: stats.size, items } : null;

// STRICT (#4115): `getPendingCounts()` reduces this list into the Review Hub's
// total/alert/todo/briefing/cos tiles, so a swallowed unreadable read reports a
// confident "0 pending" that is simply false. It is also the base of every
// read-modify-write (createItem/status updates → `saveItems`), where an
// unreadable file collapsing to `[]` would destroy every stored review item.
async function loadItemsSnapshot() {
  const stats = await statReviewFile(ITEMS_FILE);
  if (matchesFileIdentity(stats, itemsCache)) return itemsCache.items;

  // On Windows an in-flight atomic swap can report ENOENT. Let readJSONFile
  // retry that gap and avoid caching content under an unknown identity.
  const items = await readJSONFile(ITEMS_FILE, [], { strict: true });
  const snapshot = items.map(item => ({ ...item, metadata: { ...(item.metadata || {}) } }));
  itemsCache = reviewSnapshot(stats, snapshot);
  return snapshot;
}

async function loadItems() {
  return structuredClone(await loadItemsSnapshot());
}

/** Share the parsed archive across history readers and preserve strict reads for writers. */
function loadArchive() {
  if (archiveRead) return archiveRead;

  const read = statReviewFile(ARCHIVE_FILE).then(async (stats) => {
    if (matchesFileIdentity(stats, archiveCache)) return archiveCache.items;
    const items = await readJSONFile(ARCHIVE_FILE, [], { strict: true });
    // A write may have invalidated this read while it was in flight.
    if (archiveRead === read) archiveCache = reviewSnapshot(stats, items);
    return items;
  }).finally(() => {
    if (archiveRead === read) archiveRead = null;
  });
  archiveRead = read;
  return read;
}

async function saveArchive(items) {
  await atomicWrite(ARCHIVE_FILE, items);
  archiveCache = null;
  archiveRead = null;
}

/**
 * Read-only archive access for history views: on a corrupt/unreadable
 * archive.json, log and continue without archived items rather than 500ing
 * every completed/dismissed/unfiltered review read. Never used by the write
 * path (`applyRetention`), which must not mistake "unreadable" for "empty"
 * and overwrite real archived history with just the newest batch.
 */
async function loadArchiveOrEmpty(context) {
  return loadArchive().catch((err) => {
    console.error(`⚠️ Review archive unreadable (${context}), continuing without archived items: ${err.message}`);
    return [];
  });
}

/**
 * Move completed/dismissed items older than `RETENTION_AGE_MS` out of
 * items.json and into archive.json, at most once per `RETENTION_INTERVAL_MS`.
 * Writes the archive FIRST and only then returns the trimmed list for
 * `saveItems` to persist — so a crash between the two writes can duplicate an
 * item across both files, never lose one. The archive write below upserts by
 * id with the live copy winning, so that duplication self-heals on the very
 * next retention pass — one archive entry per id, and never a stale archived
 * snapshot shadowing a live copy that was edited in the meantime.
 *
 * Both the archive READ and the archive WRITE are isolated to THIS function
 * rather than left to throw: `saveItems` calls this on every
 * create/status-flip/bulk/delete, so a corrupt archive.json — or a failed
 * write to it (disk full, permission error) — must not block every live
 * review write. Either failure returns `items` untouched (items.json is not
 * rewritten either) and leaves `lastRetentionAt` alone, so the very next
 * write retries retention instead of waiting out the full interval against a
 * problem nobody has fixed yet.
 */
async function applyRetention(items) {
  const now = Date.now();
  if (now - lastRetentionAt < RETENTION_INTERVAL_MS) return items;

  const cutoff = now - RETENTION_AGE_MS;
  const remaining = [];
  const toArchive = [];
  for (const item of items) {
    const eligible = ARCHIVE_ELIGIBLE_STATUSES.has(item.status) && new Date(item.updatedAt).getTime() < cutoff;
    (eligible ? toArchive : remaining).push(item);
  }

  if (toArchive.length === 0) {
    lastRetentionAt = now;
    return items;
  }

  const archive = await loadArchive().catch((err) => {
    console.error(`⚠️ Review archive unreadable, skipping retention this cycle: ${err.message}`);
    return null;
  });
  if (!archive) return items;

  const merged = new Map(archive.map(i => [i.id, i]));
  for (const item of toArchive) merged.set(item.id, item); // live copy wins
  const archived = await saveArchive([...merged.values()]).then(() => true).catch((err) => {
    console.error(`⚠️ Failed to write review archive, skipping retention this cycle: ${err.message}`);
    return false;
  });
  if (!archived) return items;

  console.log(`📦 Review items archived: ${toArchive.length}`);
  lastRetentionAt = now;
  return remaining;
}

/**
 * Save items to file atomically, applying retention first and invalidating
 * the read cache (see the cache comment above for why it is not re-seeded
 * from what was written).
 */
async function saveItems(items) {
  await ensureDir(DATA_DIR);
  const retained = await applyRetention(items);
  await atomicWrite(ITEMS_FILE, retained);
  itemsCache = null;
}

/** Resolve an existing item's owning collection without treating a failed archive read as empty. */
async function loadItemCollection(id) {
  const items = await loadItems();
  if (items.some(item => item.id === id)) return { items, save: saveItems };
  const archived = structuredClone(await loadArchive());
  return { items: archived, save: saveArchive };
}

/**
 * Get review items sorted by type then creation date (newest first). Apply all
 * filters before returning either the full array or a requested page. The
 * optional matches predicate must treat its input as read-only.
 * A completed/dismissed or unfiltered query also merges in archive.json —
 * archive never holds a pending item, so a pending-only query skips it. A
 * corrupt archive.json degrades to "no archived items" rather than failing
 * the whole read (`loadArchiveOrEmpty`) — unlike the retention write path,
 * a read can safely omit history it could not trust. Deduped by id
 * (live copy wins) in case a crash left the same item in both files
 * mid-retention; see `applyRetention`'s doc comment.
 */
export async function getItems({ status, type, limit, offset, matches } = {}) {
  let items = [...await loadItemsSnapshot()];
  if (!status || ARCHIVE_ELIGIBLE_STATUSES.has(status)) {
    const archived = await loadArchiveOrEmpty('getItems');
    const liveIds = new Set(items.map(i => i.id));
    items = items.concat(archived.filter(i => !liveIds.has(i.id)));
  }
  if (status) items = items.filter(i => i.status === status);
  if (type) items = items.filter(i => i.type === type);
  if (matches) items = items.filter(matches);
  items.sort((a, b) => {
    const typeOrder = ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type);
    if (typeOrder !== 0) return typeOrder;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  const page = { limit, offset };
  return structuredClone(isPaginationRequested(page) ? paginateArray(items, page) : items);
}

/**
 * Get count of pending items by type
 */
export async function getPendingCounts() {
  const items = await loadItemsSnapshot();
  return items.reduce((acc, i) => {
    if (i.status !== 'pending') return acc;
    acc.total++;
    acc[i.type] = (acc[i.type] || 0) + 1;
    return acc;
  }, { total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 });
}

/**
 * Create a new review item
 */
export async function createItem({ type, title, description = '', metadata = {} }) {
  if (!ITEM_TYPES.includes(type)) {
    const err = new Error(`Invalid item type: ${type}`);
    err.status = 400;
    throw err;
  }

  return runMutation(async () => {
    const items = await loadItems();

    // Retention keeps recent alerts in the live store, which covers the 24h
    // dedup window.
    if (type === 'alert' && metadata?.referenceId) {
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const isDuplicate = (i) =>
        i.type === 'alert' &&
        i.metadata?.referenceId === metadata.referenceId &&
        new Date(i.createdAt).getTime() > oneDayAgo;
      const duplicate = items.find(isDuplicate);
      if (duplicate) return { result: duplicate };
    }

    const item = {
      id: uuidv4(),
      type,
      title,
      description,
      status: 'pending',
      metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    items.push(item);
    await saveItems(items);
    console.log(`📋 Review item created: ${type} (${item.id})`);
    return { result: item, events: [['item:created', item]] };
  });
}

function assertItemStatus(status) {
  if (!ITEM_STATUSES.includes(status)) {
    const err = new Error(`Invalid status: ${status}`);
    err.status = 400;
    throw err;
  }
}

// Queue-free body: callers already inside `runMutation` (reopenItem) use this
// directly; awaiting `updateItemStatus` from inside a region would deadlock.
async function applyItemStatus(id, status, { allowSourceOwned = false } = {}) {
  const { items, save } = await loadItemCollection(id);
  const item = items.find(i => i.id === id);
  if (!item) {
    const err = new Error(`Review item not found: ${id}`);
    err.status = 404;
    throw err;
  }

  if (status === 'completed' && !allowSourceOwned && isSourceOwnedReviewItem(item)) {
    const err = new Error('Source-owned review obligations require their owning action');
    err.status = 409;
    err.code = 'SOURCE_ACTION_REQUIRED';
    throw err;
  }

  item.status = status;
  item.updatedAt = new Date().toISOString();
  await save(items);
  console.log(`📋 Review item ${status}: ${item.type} (${item.id})`);
  return { result: item, events: [['item:updated', item]] };
}

/**
 * Update an item's status
 */
async function updateItemStatus(id, status, options) {
  assertItemStatus(status);
  return runMutation(() => applyItemStatus(id, status, options));
}

/**
 * Mark an item as completed
 */
export async function completeItem(id) {
  return updateItemStatus(id, 'completed');
}

/**
 * Reopen a completed or dismissed personal item. Archived items are moved back
 * into the live collection before the archive entry is removed so pending work
 * never remains stranded in cold storage.
 */
export async function reopenItem(id) {
  return runMutation(async () => {
    const liveItems = await loadItems();
    if (liveItems.some((item) => item.id === id)) {
      return applyItemStatus(id, 'pending');
    }

    const archived = (await loadArchive()).find(item => item.id === id);
    if (!archived) {
      const err = new Error(`Review item not found: ${id}`);
      err.status = 404;
      throw err;
    }

    const reopened = { ...structuredClone(archived), status: 'pending', updatedAt: new Date().toISOString() };
    await saveItems([...liveItems, reopened]);
    // Retention can add entries while saving the reopened live item.
    await saveArchive((await loadArchive()).filter(entry => entry.id !== id));
    console.log(`📋 Review item reopened: ${reopened.type} (${reopened.id})`);
    return { result: reopened, events: [['item:updated', reopened]] };
  });
}

/**
 * Dismiss an item
 */
export async function dismissItem(id) {
  return updateItemStatus(id, 'dismissed', { allowSourceOwned: true });
}

/**
 * Bulk-update many items to the same status in a single read-modify-write.
 * One write (and one event) for the "Complete All" / "Dismiss All" cases
 * instead of N per-item round trips; serialized with every other mutator.
 * Pass `ids` to target specific items, or omit to target every pending item.
 * Emits ONE `items:bulk-updated` event carrying every affected id rather than
 * one `item:updated` per item — "Mark all read" over N pending items used to
 * fan out N socket broadcasts, each triggering a full counts re-parse on
 * every connected dashboard client.
 */
export async function bulkUpdateStatus({ ids, status }) {
  assertItemStatus(status);

  return runMutation(async () => {
    const items = await loadItems();
    const idSet = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
    const updated = [];
    const now = new Date().toISOString();
    for (const item of items) {
      if (item.status !== 'pending') continue;
      if (idSet && !idSet.has(item.id)) continue;
      if (status === 'completed' && isSourceOwnedReviewItem(item)) continue;
      item.status = status;
      item.updatedAt = now;
      updated.push(item);
    }

    if (updated.length === 0) return { result: [] };

    await saveItems(items);
    console.log(`📋 Review items bulk-${status}: ${updated.length}`);
    return {
      result: updated,
      events: [['items:bulk-updated', { ids: updated.map(i => i.id), status, updatedAt: now }]]
    };
  });
}

/**
 * Update an item's title and/or description
 */
export async function updateItem(id, { title, description }) {
  return runMutation(async () => {
    const { items, save } = await loadItemCollection(id);
    const item = items.find(i => i.id === id);
    if (!item) {
      const err = new Error(`Review item not found: ${id}`);
      err.status = 404;
      throw err;
    }

    if (title !== undefined) item.title = title;
    if (description !== undefined) item.description = description;
    item.updatedAt = new Date().toISOString();
    await save(items);
    return { result: item, events: [['item:updated', item]] };
  });
}

/**
 * Delete a review item
 */
export async function deleteItem(id) {
  return runMutation(async () => {
    const { items, save } = await loadItemCollection(id);
    const index = items.findIndex(i => i.id === id);
    if (index === -1) {
      const err = new Error(`Review item not found: ${id}`);
      err.status = 404;
      throw err;
    }

    if (isSourceOwnedReviewItem(items[index])) {
      const err = new Error('Source-owned review obligations require triage or their owning action');
      err.status = 409;
      err.code = 'SOURCE_ACTION_REQUIRED';
      throw err;
    }

    const [removed] = items.splice(index, 1);
    await save(items);
    console.log(`📋 Review item deleted: ${removed.type} (${removed.id})`);
    return { result: removed, events: [['item:deleted', removed]] };
  });
}

/**
 * Get latest daily briefing content from the CoS reports directory
 */
export async function getBriefing() {
  const reportsDir = PATHS.reports;

  let files = [];
  try {
    files = await readdir(reportsDir);
  } catch {
    return {
      source: 'none',
      content: 'No CoS daily briefing found yet.',
      generatedAt: new Date().toISOString()
    };
  }

  const latestBriefingFile = files
    .filter(file => file.endsWith('-briefing.md'))
    .sort()
    .reverse()[0];

  if (!latestBriefingFile) {
    return {
      source: 'none',
      content: 'No CoS daily briefing found yet.',
      generatedAt: new Date().toISOString()
    };
  }

  const content = await readFile(join(reportsDir, latestBriefingFile), 'utf-8');
  const date = latestBriefingFile.replace('-briefing.md', '');

  return {
    source: 'cos',
    content,
    generatedAt: date
  };
}

export function createMemoryApprovalItem(mem, agentId, taskId) {
  return createItem({
    type: 'alert',
    title: `Memory approval: ${mem.content?.slice(0, 80) || 'New memory entry'}`,
    description: `Type: ${mem.type ?? 'unknown'} | Confidence: ${mem.confidence ?? 'N/A'}`,
    metadata: {
      referenceId: mem.id,
      category: 'memory-approval',
      actionKind: 'memory.approval',
      sourceOwned: true,
      agentId,
      taskId,
    }
  });
}

// Goal-fidelity hold (#5994): a run that shipped clean, reviewed code which does
// something other than what the task asked for. It is recorded as needs-attention
// on the agent card, but the card is only seen by someone already looking at
// /cos/agents — and "the agent built the wrong thing" is precisely the outcome
// that has to reach the human who was not watching. So it also raises a Review
// Hub alert, keyed on the agent id so `createItem`'s 24h dedup collapses a
// re-finalized run rather than filing the hold twice.
//
// The named items are model-authored text derived from an untrusted diff, so
// they are rendered as description prose and never as a link, path, or command.
cosEvents.on(GOAL_FIDELITY_HOLD_EVENT, (data) => {
  const review = data?.review;
  if (!review?.verdict) return;
  const named = [...(review.missing || []), ...(review.unrequested || [])];
  createItem({
    type: 'alert',
    title: `Goal-fidelity hold: run ${data?.agentId || 'unknown'} may have built the wrong thing`,
    description: named.length
      ? `${formatGoalFidelitySummary(review)} — ${named.slice(0, 5).join('; ')}`
      : formatGoalFidelitySummary(review),
    metadata: {
      referenceId: data?.agentId,
      category: 'goal-fidelity',
      actionKind: 'goal-fidelity.review',
      sourceOwned: true,
      agentId: data?.agentId,
      taskId: data?.taskId,
      verdict: review.verdict
    }
  }).catch(err => console.error(`❌ Failed to create goal-fidelity review alert: ${err.message}`));
});

async function updateStatusByReferenceId(referenceId, status) {
  assertItemStatus(status);

  return runMutation(async () => {
    const items = await loadItems();
    const matching = items.filter(i => i.metadata?.referenceId === referenceId && i.status === 'pending');
    if (matching.length === 0) return { result: [] };
    const now = new Date().toISOString();
    for (const item of matching) {
      item.status = status;
      item.updatedAt = now;
    }
    await saveItems(items);
    return { result: matching, events: matching.map(item => ['item:updated', item]) };
  });
}

export const dismissByReferenceId = (referenceId) => updateStatusByReferenceId(referenceId, 'dismissed');

cosEvents.on('memory:approved', (data) => {
  if (data?.id) dismissByReferenceId(data.id).catch(err => console.error(`❌ Failed to dismiss approved memory review item: ${err.message}`));
});

cosEvents.on('memory:rejected', (data) => {
  if (data?.id) dismissByReferenceId(data.id).catch(err => console.error(`❌ Failed to dismiss rejected memory review item: ${err.message}`));
});

export function removeMemoryApprovalItems(referenceId) {
  return runMutation(async () => {
    const items = await loadItems();
    const archive = await loadArchive();
    const matches = item => item.metadata?.category === 'memory-approval'
      && item.metadata.referenceId === referenceId;

    const removed = [...items.filter(matches), ...archive.filter(matches)];
    const keptArchive = archive.filter(item => !matches(item));
    if (keptArchive.length !== archive.length) await saveArchive(keptArchive);
    const keptItems = items.filter(item => !matches(item));
    if (keptItems.length !== items.length) await saveItems(keptItems);

    const ids = new Set(removed.map(item => item.id));
    return { result: ids.size, events: [...ids].map(id => ['item:deleted', { id }]) };
  });
}
