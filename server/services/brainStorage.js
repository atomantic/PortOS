/**
 * Brain Storage Service
 *
 * Handles file-based persistence for the Brain feature.
 * - Per-record `collectionStore` dirs for entity stores (people, projects,
 *   ideas, admin, …, journals, inbox, songs) — `data/brain/<type>/<id>/index.json`
 * - JSON for the single `meta.json` settings doc
 * - JSONL for append-only generated logs (digests, reviews)
 *
 * Storage layout (issue #725): each entity store is a `collectionStore` — one
 * file per record, read through to disk with no whole-store in-memory cache. A
 * write touches one record's file and per-id write queues let writes to
 * DIFFERENT records proceed in parallel (the scalability win over the old
 * monolithic `data/brain/<type>.json` + 2s-TTL cache + single global mutex).
 * Migration 200 splits the legacy monolithic files into this shape.
 *
 * The old single global write mutex is replaced by the store's per-id
 * `queueRecordWrite(id, fn)`: two writes to the SAME (type, id) serialize —
 * local create/update AND remote peer applies AND tombstone GC all queue on the
 * same per-id tail, so a peer sync landing mid-way through a local write can't
 * read a stale snapshot and drop the other write (the CLAUDE.md-sanctioned
 * "serialize two write paths that mutate the same record" case). Writes to
 * different records no longer serialize against each other. brainJournal layers
 * its own storeMutex ON TOP for the read→mutate→write of a single journal entry;
 * that only ever nests storeMutex → this per-id queue (one direction), so no
 * deadlock.
 *
 * FEDERATION is unaffected by the layout. Brain federates strictly per-record
 * through this module's API seams (`getRawRecords` / `applyRemoteRecord`) plus
 * the `brainSyncLog` delta log — never by shipping a whole-store file — so the
 * on-disk container shape is orthogonal to the wire format (no `schemaVersions.js`
 * gate; brain is intentionally ungated there).
 */

import { readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import EventEmitter from 'events';
import { atomicWrite, ensureDir, readJSONFile, safeJSONParse, safeDate, PATHS } from '../lib/fileUtils.js';
import { getInstanceId } from './instances.js';
import * as brainSyncLog from './brainSyncLog.js';
import { createCollectionStore } from '../lib/collectionStore.js';

const DATA_DIR = PATHS.brain;

// The entity stores that participate in peer sync (records with IDs).
// Canonical list — sync, tombstone GC, origin backfill, and the per-type
// collectionStore construction below all derive from it so adding a type can't
// silently drop out of one of those paths. (Boot-time migrations keep their own
// frozen copy by necessity — migrations run before the service layer is wired
// up — see scripts/migrations/080-*.js and 200-*.js.)
//
// `journals` (the Daily Log) and `inbox` were added in migration 081; both are
// `{ id: record }` stores exactly like the others (journals keyed by date,
// inbox by uuid), so the delta log, anti-entropy reconcile, tombstone GC, and
// originInstanceId backfill all cover them with no per-type branching.
export const BRAIN_ENTITY_TYPES = Object.freeze([
  'people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets',
  'journals', 'inbox', 'songs',
]);

// The type-level storage-layout version. Bumped by a migration that changes the
// on-disk layout; distinct from any per-record field-shape version (brain
// records carry none). Migration 200 stamps this on every brain type index.
export const BRAIN_STORE_SCHEMA_VERSION = 1;

// One collectionStore per entity type, rooted at data/brain/<type>/. No
// `sanitizeRecord` — brain records (and their in-place tombstones) are stored
// and loaded verbatim, exactly as the old monolithic map did.
const brainStores = Object.freeze(Object.fromEntries(
  BRAIN_ENTITY_TYPES.map((type) => [type, createCollectionStore({
    dir: join(DATA_DIR, type),
    type,
    schemaVersion: BRAIN_STORE_SCHEMA_VERSION,
  })]),
));

function storeFor(type) {
  const store = brainStores[type];
  if (!store) throw new Error(`brainStorage: unknown entity type "${type}"`);
  return store;
}

/**
 * The per-type collectionStores, for the boot-time schema-version verifier in
 * server/index.js (`verifyCollectionVersions`).
 */
export function brainCollectionStores() {
  return BRAIN_ENTITY_TYPES.map((type) => brainStores[type]);
}

// A tombstone is a deleted-record marker kept IN PLACE as the record's stored
// value (its `{id}/index.json`) — rather than removing the record dir — so the
// last-writer-wins guard in applyRemoteRecord can reject a stale `create`
// echoed back from a peer. Without it, a hard delete leaves `existing ===
// undefined`, the LWW guard is skipped, and the record resurrects — then the
// newer delete re-kills it, and both ops relay to every peer forever (the
// federated brain-sync loop). Shape:
// { _deleted: true, updatedAt, originInstanceId, deletedAt }. The `updatedAt`
// is the LWW clock; `deletedAt` is the GC clock.
const isTombstone = (rec) => !!(rec && rec._deleted);

// Build the in-place tombstone marker. `updatedAt` is the LWW clock (must be the
// delete's timestamp); `deletedAt` is the GC clock — equal at birth, kept
// separate so the GC sweep reads its own field.
const makeTombstone = (updatedAt, originInstanceId) => ({
  _deleted: true,
  updatedAt,
  originInstanceId: originInstanceId ?? 'unknown',
  deletedAt: updatedAt,
});

// GC grace period: how long a tombstone is retained before it can be hard-
// pruned. Must comfortably exceed the longest realistic peer-offline window so
// a peer that reconnects still sees the delete (not a since-vanished id that it
// would re-create). 30 days matches the sharing-side tombstone grace buffer.
export const BRAIN_TOMBSTONE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

// Non-collection files: the single settings doc and the append-only JSONL logs.
const FILES = {
  meta: join(DATA_DIR, 'meta.json'),
  digests: join(DATA_DIR, 'digests.jsonl'),
  reviews: join(DATA_DIR, 'reviews.jsonl'),
};

// Event emitter for brain data changes
export const brainEvents = new EventEmitter();

// In-memory caches — only for the non-collection files. Entity stores read
// through to disk (per issue #725: no whole-store cache to go stale when a
// per-record write bypasses it).
const caches = {
  meta: { data: null, timestamp: 0 },
  digests: { data: null, timestamp: 0 },
  reviews: { data: null, timestamp: 0 },
};

const CACHE_TTL_MS = 2000;

// Default settings
const DEFAULT_META = {
  version: 1,
  confidenceThreshold: 0.6,
  dailyDigestTime: '00:00',
  weeklyReviewTime: '00:00',
  weeklyReviewDay: 'sunday',
  defaultProvider: 'lmstudio',
  defaultModel: 'gptoss-20b',
  lastDailyDigest: null,
  lastWeeklyReview: null
};

/**
 * Ensure brain data directory exists
 */
export async function ensureBrainDir() {
  await ensureDir(DATA_DIR);
}

/**
 * Generate a new UUID
 */
export function generateId() {
  return uuidv4();
}

/**
 * Get current ISO timestamp
 */
export function now() {
  return new Date().toISOString();
}

// =============================================================================
// META / SETTINGS
// =============================================================================

/**
 * Load brain settings
 */
export async function loadMeta() {
  const cache = caches.meta;
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  await ensureBrainDir();

  const loaded = await readJSONFile(FILES.meta, null);
  cache.data = loaded ? { ...DEFAULT_META, ...loaded } : { ...DEFAULT_META };
  cache.timestamp = Date.now();
  return cache.data;
}

/**
 * Save brain settings
 */
export async function saveMeta(meta) {
  await ensureBrainDir();
  await atomicWrite(FILES.meta, meta);
  caches.meta.data = meta;
  caches.meta.timestamp = Date.now();
  brainEvents.emit('meta:changed', meta);
}

/**
 * Update brain settings (partial update)
 */
export async function updateMeta(updates) {
  const meta = await loadMeta();
  const updated = { ...meta, ...updates };
  await saveMeta(updated);
  return updated;
}

// =============================================================================
// ENTITY STORES (per-record collectionStore, read-through)
// =============================================================================

/**
 * Assemble the raw `{ id: record }` map for a type from its per-record files,
 * INCLUDING tombstones. Read-through: one `loadOne` per id, in parallel. This
 * is the seam the reconcile/anti-entropy path and getAll/getRawRecords build on
 * — identical return shape to the old monolithic `loadJsonStore(type).records`.
 */
async function loadRawMap(type) {
  const store = storeFor(type);
  const ids = await store.listIds();
  const entries = await Promise.all(ids.map(async (id) => {
    const record = await store.loadOne(id);
    return record ? [id, record] : null;
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

/**
 * Get all records from a store (tombstones excluded — they exist only to anchor
 * the LWW sync guard, never as user-visible records).
 */
export async function getAll(type) {
  const map = await loadRawMap(type);
  return Object.entries(map)
    .filter(([, record]) => !isTombstone(record))
    .map(([id, record]) => ({ id, ...record }));
}

/**
 * Get the RAW records map for a store, INCLUDING tombstones, keyed by id.
 *
 * Unlike `getAll` (which strips tombstones for user-facing reads), the sync
 * reconcile path needs tombstones too: they carry the LWW `updatedAt` clock a
 * peer must see to keep a delete from resurrecting. Returns a fresh `{ id:
 * record }` map — safe to mutate the map, but the record objects are the parsed
 * on-disk values, so callers treat them as read-only (the reconcile path only
 * serializes them, never mutates).
 */
export async function getRawRecords(type) {
  return loadRawMap(type);
}

/**
 * Get a record by ID
 */
export async function getById(type, id) {
  const record = await storeFor(type).loadOne(id);
  return record && !isTombstone(record) ? { id, ...record } : null;
}

/**
 * Create a new record
 */
export async function create(type, recordData) {
  const store = storeFor(type);
  const originInstanceId = await getInstanceId();
  const id = generateId();
  const timestamp = now();

  const record = {
    ...recordData,
    originInstanceId,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  // Fresh uuid → no read-modify-write; saveOne queues per-id internally.
  await store.saveOne(id, record);
  brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
  await brainSyncLog.appendChange('create', type, id, record, originInstanceId)
    .catch(err => console.error(`⚠️ Sync log append failed for create ${type}/${id}: ${err.message}`));

  console.log(`🧠 Created ${type} record: ${id}`);
  return { id, ...record };
}

/**
 * Update a record
 */
export async function update(type, id, updates) {
  const store = storeFor(type);
  // A malformed id can't name a valid per-record dir — treat as not-found
  // rather than letting the store's write-queue assertion throw on it.
  if (!store.isValidId(id)) return null;
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id);
    // A tombstoned record is gone — treat it as not-found rather than reviving it.
    if (!existing || isTombstone(existing)) {
      return null;
    }

    const record = {
      ...existing,
      ...updates,
      // Preserve immutable fields — originInstanceId tracks the creating instance
      originInstanceId: existing.originInstanceId,
      createdAt: existing.createdAt,
      updatedAt: now()
    };

    await store.saveOneNow(id, record);
    brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendChange('update', type, id, record, record.originInstanceId)
      .catch(err => console.error(`⚠️ Sync log append failed for update ${type}/${id}: ${err.message}`));

    console.log(`🧠 Updated ${type} record: ${id}`);
    return { id, ...record };
  });
}

/**
 * Locked read-modify-write update.
 *
 * `update(type, id, partial)` merges a partial the CALLER computed — usually
 * from a record snapshot read OUTSIDE the store write queue. When the partial
 * is derived from the current record (append to / filter an array field like
 * `attachments`), a concurrent writer landing between the snapshot read and
 * the update silently gets clobbered (and the clobber wins LWW federation).
 *
 * `updateWith` closes that window: INSIDE the per-id write queue it re-reads the
 * fresh record, calls `fn({ id, ...record })` → a partial-updates object (or
 * null/undefined to abort without writing), then merges/persists with exactly
 * `update()`'s semantics — immutable originInstanceId/createdAt, fresh
 * updatedAt stamp, `${type}:upserted` event, and a sync log append. Returns the
 * updated `{ id, ...record }`, or null when the record is missing/tombstoned or
 * fn aborted.
 */
export async function updateWith(type, id, fn) {
  const store = storeFor(type);
  if (!store.isValidId(id)) return null;
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id);
    // A tombstoned record is gone — treat it as not-found rather than reviving it.
    if (!existing || isTombstone(existing)) {
      return null;
    }

    const updates = await fn({ id, ...existing });
    if (!updates) return null;

    const record = {
      ...existing,
      ...updates,
      // Preserve immutable fields — originInstanceId tracks the creating instance
      originInstanceId: existing.originInstanceId,
      createdAt: existing.createdAt,
      updatedAt: now()
    };

    await store.saveOneNow(id, record);
    brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendChange('update', type, id, record, record.originInstanceId)
      .catch(err => console.error(`⚠️ Sync log append failed for update ${type}/${id}: ${err.message}`));

    console.log(`🧠 Updated ${type} record: ${id}`);
    return { id, ...record };
  });
}

/**
 * Upsert a record under a CALLER-PROVIDED id (full replace, create-if-missing).
 *
 * `create()` mints a uuid, which is wrong for stores whose identity is a natural
 * key — the Daily Log keys entries by calendar date so the same day converges
 * across peers instead of forking into per-machine uuids. This primitive lets
 * such a store own its id while still riding the exact entity-store contract:
 * it preserves `originInstanceId`/`createdAt` from an existing live record,
 * stamps a fresh `updatedAt` (the LWW clock), appends a create/update entry to
 * the sync log, and emits `${type}:upserted` unless the caller suppresses it.
 *
 * `recordData` is stored verbatim except for the three managed fields — callers
 * pass the FULL desired record (this does not merge unknown fields the way
 * `update()` does). `emitEvent:false` lets a caller (e.g. brainJournal) emit its
 * own richer, bridge-shaped event instead of the generic one.
 */
export async function upsertWithId(type, id, recordData, { emitEvent = true } = {}) {
  const store = storeFor(type);
  // Resolve our instance id outside the queue (independent read); the existing
  // record's origin is preferred inside the queue when one is present.
  const fallbackOrigin = await getInstanceId();
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id);
    const live = existing && !isTombstone(existing) ? existing : null;
    const timestamp = now();
    const originInstanceId = live?.originInstanceId ?? fallbackOrigin;

    const record = {
      ...recordData,
      originInstanceId,
      createdAt: live?.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    await store.saveOneNow(id, record);
    if (emitEvent) brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendChange(live ? 'update' : 'create', type, id, record, originInstanceId)
      .catch(err => console.error(`⚠️ Sync log append failed for upsert ${type}/${id}: ${err.message}`));

    console.log(`🧠 Upserted ${type} record: ${id}`);
    return { id, ...record };
  });
}

/**
 * Apply many record updates to one store.
 *
 * With the old monolithic file, a batch (e.g. a chip reorder) had to be one
 * atomic load-modify-save or N concurrent single-record `update()` calls would
 * read overlapping baselines of the shared file and last-save-wins. Per-record
 * files remove that race entirely — writes to different ids no longer share a
 * file — so this now serializes each record on its own per-id queue and merges
 * against the freshest persisted record. `updates` is an array of { id,
 * ...fields }; unknown/tombstoned ids are skipped. Returns the updated records.
 */
export async function updateMany(type, updates) {
  const store = storeFor(type);
  const applied = [];
  for (const { id, ...fields } of updates) {
    if (!store.isValidId(id)) continue;
    const record = await store.queueRecordWrite(id, async () => {
      const existing = await store.loadOne(id);
      if (!existing || isTombstone(existing)) return null;
      const next = {
        ...existing,
        ...fields,
        // Preserve immutable fields, exactly as update() does.
        originInstanceId: existing.originInstanceId,
        createdAt: existing.createdAt,
        updatedAt: now()
      };
      await store.saveOneNow(id, next);
      return next;
    });
    if (record) applied.push({ id, record });
  }
  if (applied.length === 0) return [];

  for (const { id, record } of applied) {
    brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendChange('update', type, id, record, record.originInstanceId)
      .catch(err => console.error(`⚠️ Sync log append failed for update ${type}/${id}: ${err.message}`));
  }
  console.log(`🧠 Updated ${applied.length} ${type} records in one batch`);
  return applied.map(({ id, record }) => ({ id, ...record }));
}

/**
 * Delete a record
 */
export async function remove(type, id) {
  const store = storeFor(type);
  if (!store.isValidId(id)) return false;
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id);
    // Already gone (absent) or already tombstoned — nothing to delete, and
    // re-tombstoning would mint a redundant sync-log entry that relays needlessly.
    if (!existing || isTombstone(existing)) {
      return false;
    }

    const originInstanceId = existing.originInstanceId ?? 'unknown';
    const deletedRecord = { id, ...existing };
    const ts = now();
    // Retain a tombstone in place (save it as the record's value, not a hard
    // delete of the record dir) so a stale `create` echoed from a peer is
    // rejected by the LWW guard in applyRemoteRecord.
    await store.saveOneNow(id, makeTombstone(ts, originInstanceId));
    brainEvents.emit(`${type}:deleted`, { id, record: deletedRecord });
    // Wire format unchanged: the sync-log delete entry still carries only
    // { updatedAt } so an older peer (no tombstone support) applies it as a
    // plain hard delete exactly as before.
    await brainSyncLog.appendChange('delete', type, id, { updatedAt: ts }, originInstanceId)
      .catch(err => console.error(`⚠️ Sync log append failed for delete ${type}/${id}: ${err.message}`));

    console.log(`🧠 Deleted ${type} record: ${id}`);
    return true;
  });
}

/**
 * Query records with filters
 */
export async function query(type, filters = {}) {
  const records = await getAll(type);

  return records.filter(record => {
    for (const [key, value] of Object.entries(filters)) {
      if (record[key] !== value) return false;
    }
    return true;
  });
}

// =============================================================================
// JSONL APPEND LOGS (digests, reviews)
// =============================================================================

/**
 * Load all records from a JSONL file
 */
async function loadJsonlStore(type) {
  const cache = caches[type];
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  await ensureBrainDir();
  const filePath = FILES[type];

  if (!existsSync(filePath)) {
    cache.data = [];
    cache.timestamp = Date.now();
    return cache.data;
  }

  const content = await readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());
  cache.data = lines.map(line => safeJSONParse(line, null)).filter(item => item !== null);
  cache.timestamp = Date.now();
  return cache.data;
}

/**
 * Append a record to a JSONL file
 */
async function appendJsonl(type, record) {
  await ensureBrainDir();
  const line = JSON.stringify(record) + '\n';
  await appendFile(FILES[type], line);

  // Invalidate cache so next read gets fresh data
  caches[type].data = null;
  caches[type].timestamp = 0;

  brainEvents.emit(`${type}:added`, record);
}

// =============================================================================
// INBOX LOG OPERATIONS
// =============================================================================

// The inbox is an id-keyed entity store (see BRAIN_ENTITY_TYPES) so it
// federates through the same delta-log + LWW + tombstone pipeline as every other
// brain type. These wrappers keep the historical getInboxLog/createInboxLog/…
// API (capturedAt sort, status counts) on top of the generic entity primitives.

/**
 * Get all inbox log entries (newest-first by capturedAt), optional status filter.
 */
export async function getInboxLog(options = {}) {
  const { status, limit = 50, offset = 0 } = options;
  let records = await getAll('inbox');

  records = records.sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));

  if (status) {
    records = records.filter(r => r.status === status);
  }

  return records.slice(offset, offset + limit);
}

/**
 * Get inbox log entry by ID
 */
export async function getInboxLogById(id) {
  return getById('inbox', id);
}

// The inbox's concurrent same-record write paths (a capture's create immediately
// followed by a background-classification update on the same entry, plus the
// boot recovery sweep) are serialized by create/update/remove's own per-id write
// queue — no separate inbox lock is needed.

/**
 * Create inbox log entry. `capturedAt` is the user-facing capture time (kept
 * distinct from the sync `createdAt`/`updatedAt` clocks stamped by create()).
 */
export async function createInboxLog(entry) {
  return create('inbox', { ...entry, capturedAt: entry.capturedAt || now() });
}

/**
 * Update inbox log entry (partial merge — returns null if absent/tombstoned).
 */
export async function updateInboxLog(id, updates) {
  return update('inbox', id, updates);
}

/**
 * Delete inbox log entry (tombstones in place for sync convergence).
 */
export async function deleteInboxLog(id) {
  return remove('inbox', id);
}

/**
 * Get inbox log count by status
 */
export async function getInboxLogCounts() {
  const records = await getAll('inbox');

  const counts = {
    total: records.length,
    classifying: 0,
    filed: 0,
    needs_review: 0,
    corrected: 0,
    done: 0,
    error: 0
  };

  for (const record of records) {
    if (counts[record.status] !== undefined) {
      counts[record.status]++;
    }
  }

  return counts;
}

// =============================================================================
// DIGEST OPERATIONS
// =============================================================================

/**
 * Get all digests
 */
export async function getDigests(limit = 10) {
  let records = await loadJsonlStore('digests');
  records = records.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  return records.slice(0, limit);
}

/**
 * Get latest digest
 */
export async function getLatestDigest() {
  const digests = await getDigests(1);
  return digests[0] || null;
}

/**
 * Create digest entry
 */
export async function createDigest(digest) {
  const record = {
    id: generateId(),
    ...digest,
    generatedAt: now()
  };

  await appendJsonl('digests', record);

  // Update meta with last digest time
  await updateMeta({ lastDailyDigest: record.generatedAt });

  console.log(`🧠 Created daily digest: ${record.id}`);
  return record;
}

// =============================================================================
// REVIEW OPERATIONS
// =============================================================================

/**
 * Get all reviews
 */
export async function getReviews(limit = 10) {
  let records = await loadJsonlStore('reviews');
  records = records.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  return records.slice(0, limit);
}

/**
 * Get latest review
 */
export async function getLatestReview() {
  const reviews = await getReviews(1);
  return reviews[0] || null;
}

/**
 * Create review entry
 */
export async function createReview(review) {
  const record = {
    id: generateId(),
    ...review,
    generatedAt: now()
  };

  await appendJsonl('reviews', record);

  // Update meta with last review time
  await updateMeta({ lastWeeklyReview: record.generatedAt });

  console.log(`🧠 Created weekly review: ${record.id}`);
  return record;
}

// =============================================================================
// CONVENIENCE EXPORTS FOR ENTITY TYPES
// =============================================================================

// People
export const getPeople = (filters) => filters ? query('people', filters) : getAll('people');
export const getPersonById = (id) => getById('people', id);
export const createPerson = (data) => create('people', data);
export const updatePerson = (id, data) => update('people', id, data);
export const deletePerson = (id) => remove('people', id);

// Projects
export const getProjects = (filters) => filters ? query('projects', filters) : getAll('projects');
export const getProjectById = (id) => getById('projects', id);
export const createProject = (data) => create('projects', data);
export const updateProject = (id, data) => update('projects', id, data);
export const deleteProject = (id) => remove('projects', id);

// Ideas
export const getIdeas = (filters) => filters ? query('ideas', filters) : getAll('ideas');
export const getIdeaById = (id) => getById('ideas', id);
export const createIdea = (data) => create('ideas', data);
export const updateIdea = (id, data) => update('ideas', id, data);
export const deleteIdea = (id) => remove('ideas', id);

// Admin
export const getAdminItems = (filters) => filters ? query('admin', filters) : getAll('admin');
export const getAdminById = (id) => getById('admin', id);
export const createAdminItem = (data) => create('admin', data);
export const updateAdminItem = (id, data) => update('admin', id, data);
export const deleteAdminItem = (id) => remove('admin', id);

// Memories
/**
 * Effective recency timestamp (ms epoch) for ordering a memory entry newest-first.
 *
 * Imported conversations (ChatGPT) carry the original conversation clock in
 * `sourceUpdatedAt` / `sourceCreatedAt`. A ChatGPT export is NOT ordered
 * chronologically, and every entry from one bulk import shares the same
 * `createdAt`/`updatedAt` (the import time) — so sorting on the storage clock
 * leaves imports in arbitrary export order (the user-reported bug). Prefer the
 * source clock when present, falling back to the storage clock for hand-written
 * entries. Returns 0 for a missing/unparseable timestamp so it sorts last.
 */
export const memoryRecencyMs = (record) => {
  for (const candidate of [
    record?.sourceUpdatedAt,
    record?.sourceCreatedAt,
    record?.updatedAt,
    record?.createdAt,
  ]) {
    const t = safeDate(candidate); // epoch ms, or 0 for missing/unparseable
    if (t) return t;
  }
  return 0;
};

export const getMemoryEntries = async () => {
  const entries = await getAll('memories');
  // Decorate-sort-undecorate: compute each record's recency once (a bulk ChatGPT
  // import can be hundreds of entries — recomputing it inside the comparator
  // would parse every timestamp O(n log n) times).
  return entries
    .map((entry) => ({ entry, recency: memoryRecencyMs(entry) }))
    .sort((a, b) => b.recency - a.recency)
    .map(({ entry }) => entry);
};
export const getMemoryEntryById = (id) => getById('memories', id);
export const createMemoryEntry = (data) => create('memories', data);
export const updateMemoryEntry = (id, data) => update('memories', id, data);
export const deleteMemoryEntry = (id) => remove('memories', id);

// Links
export const getLinks = (filters) => filters ? query('links', filters) : getAll('links');
export const getLinkById = (id) => getById('links', id);
export const createLink = (data) => create('links', data);
export const updateLink = (id, data) => update('links', id, data);
// Batch reorder: per-id write queues so a multi-chip drag merges each link
// against its freshest persisted record.
export const reorderLinks = (updates) => updateMany('links', updates);
export const deleteLink = (id) => remove('links', id);

/**
 * Find link by URL
 */
export async function getLinkByUrl(url) {
  const links = await getAll('links');
  return links.find(link => link.url === url) || null;
}

// Buckets (bookmark groups for links)
export const getBuckets = (filters) => filters ? query('buckets', filters) : getAll('buckets');
export const getBucketById = (id) => getById('buckets', id);
export const createBucket = (data) => create('buckets', data);
export const updateBucket = (id, data) => update('buckets', id, data);
export const deleteBucket = (id) => remove('buckets', id);

// =============================================================================
// REMOTE SYNC OPERATIONS (no events, no sync log — echo prevention)
// =============================================================================

/**
 * Apply a remote record to a store (last-writer-wins by updatedAt)
 */
export async function applyRemoteRecord(type, id, record, op) {
  const store = storeFor(type);
  // Reject a malformed id (can't name a valid per-record dir) or a
  // prototype-polluting name — the store's `isValidId` owns both the format
  // allowlist AND the reserved-key denylist (`__proto__`/`constructor`/
  // `prototype`), so a bad id returns `invalid_id` here instead of throwing on
  // the write-queue assertion or appending a phantom relay entry that can never
  // converge (this covers BOTH the delta-sync and reconcile-snapshot callers).
  if (!store.isValidId(id)) {
    return { applied: false, reason: 'invalid_id' };
  }
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id);

    if (op === 'delete') {
      // Require updatedAt on delete operations for last-writer-wins conflict resolution
      if (!record?.updatedAt) {
        return { applied: false, reason: 'missing_timestamp' };
      }
      // LWW: skip if our copy (live record OR existing tombstone) is at least as
      // new as the incoming delete. The tombstone-vs-tombstone case makes a
      // repeated delete idempotent → not relayed → the echo loop converges.
      if (existing && existing.updatedAt >= record.updatedAt) {
        return { applied: false, reason: 'local_newer' };
      }
      // Tombstone in place even when no local record exists. A delete that
      // arrives before we ever saw a create still leaves a marker, so a later
      // stale create for that id is rejected instead of resurrecting.
      await store.saveOneNow(id, makeTombstone(
        record.updatedAt,
        record.originInstanceId ?? existing?.originInstanceId
      ));
    } else {
      // A create/update with no updatedAt has no LWW clock — `existing.updatedAt
      // >= undefined` is always false, which would let it silently overwrite a
      // tombstone and resurrect a deleted record. Reject it (mirrors the delete
      // path) so the loop-breaker can't be defeated by a timestamp-less create.
      if (!record?.updatedAt) {
        return { applied: false, reason: 'missing_timestamp' };
      }
      // Guard also fires when `existing` is a tombstone — a stale create (older
      // updatedAt than the recorded delete) is rejected, breaking the
      // resurrection loop. A genuinely newer create (later updatedAt than the
      // tombstone) still wins and legitimately revives the record.
      if (existing && existing.updatedAt >= record.updatedAt) {
        return { applied: false, reason: 'local_newer' };
      }
      // Defense-in-depth: a create carrying `_deleted` (a future peer, or a
      // direct caller bypassing brainSync's reroute) must persist as a proper
      // tombstone, never as a malformed live record missing `deletedAt`.
      await store.saveOneNow(id, record._deleted
        ? makeTombstone(record.updatedAt, record.originInstanceId ?? existing?.originInstanceId)
        : { ...record });
    }

    return { applied: true };
  });
}

/**
 * Hard-prune tombstones older than `cutoffMs` (a Date.now()-style epoch ms).
 * Called by the brain tombstone GC sweep on the orchestrator's interval.
 * Per-id re-check inside the write queue so a tombstone a concurrent apply just
 * refreshed isn't pruned on a stale read. Returns the number of tombstones
 * removed.
 */
export async function pruneTombstones(type, cutoffMs) {
  const store = storeFor(type);
  const ids = await store.listIds();
  // Different ids are independent files — prune them in parallel (each still
  // serialized on its own per-id queue so the stale-read recheck holds). The
  // count is order-independent.
  const results = await Promise.all(ids.map((id) => store.queueRecordWrite(id, async () => {
    const record = await store.loadOne(id);
    if (!isTombstone(record)) return false;
    const deletedAt = Date.parse(record.deletedAt ?? record.updatedAt ?? '');
    if (Number.isFinite(deletedAt) && deletedAt < cutoffMs) {
      await store.deleteOneNow(id);
      return true;
    }
    return false;
  })));
  return results.filter(Boolean).length;
}

/**
 * Backfill originInstanceId on records missing it (run once at startup)
 */
export async function backfillOriginInstanceId() {
  const instanceId = await getInstanceId();

  // Every record across all types is an independent file — backfill them in
  // parallel (per-id writes still serialize on their own queue). This runs at
  // startup and gates sync start, so the parallelism directly shortens boot.
  const perType = await Promise.all(BRAIN_ENTITY_TYPES.map(async (type) => {
    const store = storeFor(type);
    const ids = await store.listIds();
    const changes = await Promise.all(ids.map((id) => store.queueRecordWrite(id, async () => {
      const record = await store.loadOne(id);
      // Tombstones always carry originInstanceId; skip them and absent records.
      if (!record || isTombstone(record) || record.originInstanceId) return false;
      await store.saveOneNow(id, { ...record, originInstanceId: instanceId });
      return true;
    })));
    return changes.filter(Boolean).length;
  }));

  const totalBackfilled = perType.reduce((sum, n) => sum + n, 0);
  if (totalBackfilled > 0) {
    console.log(`🧠 Backfilled originInstanceId on ${totalBackfilled} records`);
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Invalidate the non-collection caches (meta + JSONL logs). Entity stores read
 * through to disk, so there is no entity cache to clear.
 */
export function invalidateAllCaches() {
  for (const key of Object.keys(caches)) {
    caches[key].data = null;
    caches[key].timestamp = 0;
  }
}

/**
 * Get brain data summary (for dashboard)
 */
export async function getSummary() {
  const [people, projects, ideas, adminItems, memoryEntries, links, buckets, inboxCounts, meta] = await Promise.all([
    getAll('people'),
    getAll('projects'),
    getAll('ideas'),
    getAll('admin'),
    getAll('memories'),
    getAll('links'),
    getAll('buckets'),
    getInboxLogCounts(),
    loadMeta()
  ]);

  return {
    counts: {
      people: people.length,
      projects: projects.length,
      ideas: ideas.length,
      admin: adminItems.length,
      memories: memoryEntries.length,
      links: links.length,
      buckets: buckets.length,
      inbox: inboxCounts
    },
    activeProjects: projects.filter(p => p.status === 'active').length,
    activeIdeas: ideas.filter(i => !i.status || i.status === 'active').length,
    openAdmin: adminItems.filter(a => a.status === 'open').length,
    gitHubRepos: links.filter(l => l.isGitHubRepo).length,
    needsReview: inboxCounts.needs_review,
    lastDailyDigest: meta.lastDailyDigest,
    lastWeeklyReview: meta.lastWeeklyReview
  };
}
