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
import { cosEvents } from './cosEvents.js';
import { GOAL_FIDELITY_HOLD_EVENT, formatGoalFidelitySummary } from '../lib/goalFidelity.js';

const DATA_DIR = join(PATHS.data, 'review');
const ITEMS_FILE = join(DATA_DIR, 'items.json');
// Cold storage for completed/dismissed items retention moves out of items.json
// (see `applyRetention` below) — same file-backed record kind, split by age,
// inside the existing `data/review/` directory rather than a new data store.
const ARCHIVE_FILE = join(DATA_DIR, 'archive.json');

export const reviewEvents = new EventEmitter();

// Valid item types and statuses
const ITEM_TYPES = ['alert', 'todo', 'briefing', 'cos'];
const ITEM_STATUSES = ['pending', 'completed', 'dismissed'];

// Retention: on a daily debounce, move completed/dismissed items older than
// this out of items.json and into archive.json (see `applyRetention`).
const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_ELIGIBLE_STATUSES = new Set(['completed', 'dismissed']);

// Module-level cache of the parsed items.json, keyed on file identity (mtime +
// size) rather than an in-process "loaded" flag: `dataManager.js` registers
// `review` as archivable/deletable, so `data/review/` can be archived or
// deleted out from under this process while it runs, and a flag-based cache
// would keep serving a since-deleted file's contents forever. `saveItems`
// INVALIDATES the cache after every write rather than seeding it from what it
// wrote: two saveItems calls can interleave (a route and a cosEvents handler
// — the same window as the documented lost-update race), and a post-write
// stat could then pin one writer's content under the other writer's identity
// and serve it until the next write. Invalidation keeps the invariant simple —
// the cache only ever holds content read from the file under its own identity
// — at the cost of one re-parse per write.
//
// `loadItems()` hands every caller a fresh shallow clone (see `cloneItems`),
// never the cached array/objects themselves — `getItems` is a public export
// with callers outside this module's own mutate-then-save discipline, and a
// caller that decorated or edited a returned item in place would otherwise
// silently pollute the cache, later persisted by the next unrelated
// `saveItems` call. The internal mutation paths below (createItem/
// updateItemStatus/bulkUpdateStatus/updateItem/deleteItem/
// updateStatusByReferenceId) mutate the clone `loadItems()` gave them and
// then immediately call `saveItems` with it — nothing they hold is ever
// cached, so the objects those paths return to their callers are theirs to
// mutate too.
let itemsCache = null; // { mtimeMs, size, items }
let lastRetentionAt = 0; // 0 so the first save after boot always evaluates retention

const cloneItems = (items) => items.map(i => ({ ...i, metadata: { ...(i.metadata || {}) } }));

/**
 * Load all review items from file, reusing the cached parse when the file's
 * mtime/size haven't changed since the last read. Always returns a clone —
 * see the cache comment above.
 */
// STRICT (#4115): `getPendingCounts()` reduces this list into the Review Hub's
// total/alert/todo/briefing/cos tiles, so a swallowed unreadable read reports a
// confident "0 pending" that is simply false. It is also the base of every
// read-modify-write (createItem/status updates → `saveItems`), where an
// unreadable file collapsing to `[]` would destroy every stored review item.
async function loadItems() {
  const stats = await stat(ITEMS_FILE).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });

  if (stats && itemsCache && itemsCache.mtimeMs === stats.mtimeMs && itemsCache.size === stats.size) {
    return cloneItems(itemsCache.items);
  }

  // A stat ENOENT is NOT collapsed to `[]` here: on win32 an `atomicWrite`
  // swap in flight (temp file renamed over the target) reports ENOENT for a
  // moment too, and only readJSONFile's swap-aware retry can tell that apart
  // from a genuinely absent file (which it returns `[]` for). Short-circuiting
  // would hand a concurrent read-modify-write (a cosEvents `task:ready` burst)
  // an empty list to save over every stored item. Nothing is cached under an
  // unknown identity — the next read re-stats and re-parses.
  const items = await readJSONFile(ITEMS_FILE, [], { strict: true });
  itemsCache = stats ? { mtimeMs: stats.mtimeMs, size: stats.size, items } : null;
  return cloneItems(items);
}

/**
 * Load the archived (retired) items. Never cached — only read from the
 * history views (`getItems` for a completed/dismissed/unfiltered query,
 * and `createItem`'s duplicate-alert check when the live scan misses).
 * Strict: a caller that must not silently treat "unreadable" as "empty"
 * (`applyRetention`, before it trusts the file enough to write over it)
 * awaits this directly. A read-only view that can safely degrade instead
 * uses `loadArchiveOrEmpty`.
 */
async function loadArchive() {
  return readJSONFile(ARCHIVE_FILE, [], { strict: true });
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
  const archived = await atomicWrite(ARCHIVE_FILE, [...merged.values()]).then(() => true).catch((err) => {
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

/**
 * Get all review items, sorted by type then creation date (newest first).
 * A completed/dismissed or unfiltered query also merges in archive.json —
 * archive never holds a pending item, so a pending-only query skips it. A
 * corrupt archive.json degrades to "no archived items" rather than failing
 * the whole read (`loadArchiveOrEmpty`) — unlike the retention write path,
 * a read can safely omit history it could not trust. Deduped by id
 * (live copy wins) in case a crash left the same item in both files
 * mid-retention; see `applyRetention`'s doc comment.
 */
export async function getItems({ status, type } = {}) {
  let items = await loadItems();
  if (!status || ARCHIVE_ELIGIBLE_STATUSES.has(status)) {
    const archived = await loadArchiveOrEmpty('getItems');
    const liveIds = new Set(items.map(i => i.id));
    items = items.concat(archived.filter(i => !liveIds.has(i.id)));
  }
  if (status) items = items.filter(i => i.status === status);
  if (type) items = items.filter(i => i.type === type);
  return items.sort((a, b) => {
    const typeOrder = ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type);
    if (typeOrder !== 0) return typeOrder;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

/**
 * Get count of pending items by type
 */
export async function getPendingCounts() {
  const items = await loadItems();
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

  const items = await loadItems();

  // Prevent duplicate alerts for same reference within 24 hours. Archive only
  // ever holds items >=30 days old, so it can never actually match this 24h
  // window in practice — but check it anyway rather than silently narrowing
  // the dedup window the day an item crosses into archive.json. Only
  // consulted when the live scan misses, so the common case (no dedup match,
  // or a live match) never touches the archive file. A corrupt archive.json
  // degrades to "no archived duplicate found" (`loadArchiveOrEmpty`) rather
  // than blocking item creation entirely.
  if (type === 'alert' && metadata?.referenceId) {
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isDuplicate = (i) =>
      i.type === 'alert' &&
      i.metadata?.referenceId === metadata.referenceId &&
      new Date(i.createdAt).getTime() > oneDayAgo;
    const duplicate = items.find(isDuplicate) ?? (await loadArchiveOrEmpty('createItem duplicate check')).find(isDuplicate);
    if (duplicate) return duplicate;
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
  console.log(`📋 Review item created: ${type} — ${title}`);
  reviewEvents.emit('item:created', item);
  return item;
}

/**
 * Update an item's status
 */
async function updateItemStatus(id, status) {
  if (!ITEM_STATUSES.includes(status)) {
    const err = new Error(`Invalid status: ${status}`);
    err.status = 400;
    throw err;
  }

  const items = await loadItems();
  const item = items.find(i => i.id === id);
  if (!item) {
    const err = new Error(`Review item not found: ${id}`);
    err.status = 404;
    throw err;
  }

  item.status = status;
  item.updatedAt = new Date().toISOString();
  await saveItems(items);
  console.log(`📋 Review item ${status}: ${item.type} — ${item.title}`);
  reviewEvents.emit('item:updated', item);
  return item;
}

/**
 * Mark an item as completed
 */
export async function completeItem(id) {
  return updateItemStatus(id, 'completed');
}

/**
 * Dismiss an item
 */
export async function dismissItem(id) {
  return updateItemStatus(id, 'dismissed');
}

/**
 * Bulk-update many items to the same status in a single read-modify-write.
 * Concurrent per-item POSTs race on saveItems and silently drop updates;
 * this endpoint handles the "Complete All" / "Dismiss All" cases atomically.
 * Pass `ids` to target specific items, or omit to target every pending item.
 * Emits ONE `items:bulk-updated` event carrying every affected id rather than
 * one `item:updated` per item — "Mark all read" over N pending items used to
 * fan out N socket broadcasts, each triggering a full counts re-parse on
 * every connected dashboard client.
 */
export async function bulkUpdateStatus({ ids, status }) {
  if (!ITEM_STATUSES.includes(status)) {
    const err = new Error(`Invalid status: ${status}`);
    err.status = 400;
    throw err;
  }

  const items = await loadItems();
  const idSet = Array.isArray(ids) && ids.length > 0 ? new Set(ids) : null;
  const updated = [];
  const now = new Date().toISOString();
  for (const item of items) {
    if (item.status !== 'pending') continue;
    if (idSet && !idSet.has(item.id)) continue;
    item.status = status;
    item.updatedAt = now;
    updated.push(item);
  }

  if (updated.length === 0) return [];

  await saveItems(items);
  console.log(`📋 Review items bulk-${status}: ${updated.length}`);
  reviewEvents.emit('items:bulk-updated', { ids: updated.map(i => i.id), status, updatedAt: now });
  return updated;
}

/**
 * Update an item's title and/or description
 */
export async function updateItem(id, { title, description }) {
  const items = await loadItems();
  const item = items.find(i => i.id === id);
  if (!item) {
    const err = new Error(`Review item not found: ${id}`);
    err.status = 404;
    throw err;
  }

  if (title !== undefined) item.title = title;
  if (description !== undefined) item.description = description;
  item.updatedAt = new Date().toISOString();
  await saveItems(items);
  reviewEvents.emit('item:updated', item);
  return item;
}

/**
 * Delete a review item
 */
export async function deleteItem(id) {
  const items = await loadItems();
  const index = items.findIndex(i => i.id === id);
  if (index === -1) {
    const err = new Error(`Review item not found: ${id}`);
    err.status = 404;
    throw err;
  }

  const [removed] = items.splice(index, 1);
  await saveItems(items);
  console.log(`📋 Review item deleted: ${removed.type} — ${removed.title}`);
  reviewEvents.emit('item:deleted', removed);
  return removed;
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

/**
 * Bridge CoS events into review items
 */
cosEvents.on('memory:approval-needed', (data) => {
  const memories = data?.memories ?? [];
  for (const mem of memories) {
    createItem({
      type: 'alert',
      title: `Memory approval: ${mem.content?.slice(0, 80) || 'New memory entry'}`,
      description: `Type: ${mem.type ?? 'unknown'} | Confidence: ${mem.confidence ?? 'N/A'}`,
      metadata: { referenceId: mem.id, category: 'memory-approval', agentId: data?.agentId, taskId: data?.taskId }
    }).catch(err => console.error(`❌ Failed to create review alert: ${err.message}`));
  }
});

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
      agentId: data?.agentId,
      taskId: data?.taskId,
      verdict: review.verdict
    }
  }).catch(err => console.error(`❌ Failed to create goal-fidelity review alert: ${err.message}`));
});

async function updateStatusByReferenceId(referenceId, status) {
  if (!ITEM_STATUSES.includes(status)) {
    const err = new Error(`Invalid status: ${status}`);
    err.status = 400;
    throw err;
  }

  const items = await loadItems();
  const matching = items.filter(i => i.metadata?.referenceId === referenceId && i.status === 'pending');
  if (matching.length === 0) return;
  const now = new Date().toISOString();
  for (const item of matching) {
    item.status = status;
    item.updatedAt = now;
  }
  await saveItems(items);
  for (const item of matching) reviewEvents.emit('item:updated', item);
}

const dismissByReferenceId = (referenceId) => updateStatusByReferenceId(referenceId, 'dismissed');
const completeByReferenceId = (referenceId) => updateStatusByReferenceId(referenceId, 'completed');

cosEvents.on('memory:approved', (data) => {
  if (data?.id) dismissByReferenceId(data.id).catch(err => console.error(`❌ Failed to dismiss approved memory review item: ${err.message}`));
});

cosEvents.on('memory:rejected', (data) => {
  if (data?.id) dismissByReferenceId(data.id).catch(err => console.error(`❌ Failed to dismiss rejected memory review item: ${err.message}`));
});

cosEvents.on('task:ready', (data) => {
  createItem({
    type: 'cos',
    title: data?.title ?? data?.description ?? 'CoS action requires review',
    description: data?.description ?? '',
    metadata: { taskId: data?.id, referenceId: data?.id }
  }).catch(err => console.error(`❌ Failed to create review item: ${err.message}`));
});

// When a CoS agent finishes a task, auto-resolve the matching review item so
// the user isn't asked to manually mark something complete that an agent
// already handled. Success → complete; failure stays pending so the user can
// see and act on it.
cosEvents.on('agent:completed', (agent) => {
  const taskId = agent?.taskId;
  if (!taskId) return;
  if (agent.result?.success) {
    completeByReferenceId(taskId).catch(err =>
      console.error(`❌ Failed to auto-complete review item for task ${taskId}: ${err.message}`)
    );
  }
});

// When a task is deleted, dismiss any pending review items still pointing at it.
// Otherwise the user is left staring at an orphaned alert for a task that no
// longer exists — and its "Review"/approve action resolves nothing because the
// underlying task is gone. Mirrors the memory:approved/rejected cleanup.
cosEvents.on('tasks:changed', (data) => {
  if (data?.action !== 'deleted' || !data?.taskId) return;
  dismissByReferenceId(data.taskId).catch(err =>
    console.error(`❌ Failed to dismiss review items for deleted task ${data.taskId}: ${err.message}`)
  );
});
