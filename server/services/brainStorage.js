/**
 * Brain Storage Service
 *
 * Handles file-based persistence for the Brain feature.
 * - JSON for entity stores (people, projects, ideas, admin, …, journals, inbox)
 * - JSONL for append-only generated logs (digests, reviews)
 * - In-memory caching with TTL for performance
 */

import { readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import EventEmitter from 'events';
import { atomicWrite, ensureDir, readJSONFile, safeJSONParse, safeDate, PATHS } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { getInstanceId } from './instances.js';
import * as brainSyncLog from './brainSyncLog.js';

// ONE mutex serializes EVERY write to a brain entity store — local mutations
// (create/update/remove/upsertWithId/updateMany) AND remote peer applies
// (applyRemoteRecord) AND tombstone GC. They all do whole-file read-modify-write
// on the same data/brain/<type>.json, so a peer sync landing mid-way through a
// local journal append / inbox capture (or vice-versa) would otherwise read a
// stale snapshot and drop the other write. This is the CLAUDE.md-sanctioned
// "serialize two write paths that mutate the same record" case (sync orchestrator
// vs request handler are two in-process writers, not competing humans) — NOT a
// concurrency defense against multiple users. brainJournal layers its own
// storeMutex ON TOP for the read→mutate→write of a single journal entry; that
// only ever nests storeMutex → this lock (one direction), so no deadlock.
const withStoreWriteLock = createMutex();

const DATA_DIR = PATHS.brain;

// The JSON entity stores that participate in peer sync (have records with IDs).
// Canonical list — sync, tombstone GC, and origin backfill all derive from it
// so adding a type can't silently drop out of one of those paths. (The
// boot-time migration keeps its own copy by necessity — migrations run before
// the service layer is wired up — see scripts/migrations/080-*.js.)
//
// `journals` (the Daily Log) and `inbox` were added in migration 081: both were
// previously stored OUTSIDE this contract (journals in a separate brainJournal
// store, inbox as an append-only JSONL) and so never entered the sync log —
// they silently never federated. They are now `{ records: { id: record } }`
// stores exactly like the others (journals keyed by date, inbox by uuid), so
// the delta log, anti-entropy reconcile, tombstone GC, and originInstanceId
// backfill all cover them with no per-type branching.
export const BRAIN_ENTITY_TYPES = Object.freeze([
  'people', 'projects', 'ideas', 'admin', 'memories', 'links', 'buckets',
  'journals', 'inbox', 'songs',
]);

// A tombstone is a deleted-record marker kept IN PLACE in `data.records[id]`
// (rather than removing the key) so the last-writer-wins guard in
// applyRemoteRecord can reject a stale `create` echoed back from a peer.
// Without it, a hard delete leaves `existing === undefined`, the LWW guard is
// skipped, and the record resurrects — then the newer delete re-kills it, and
// both ops relay to every peer forever (the federated brain-sync loop).
// Shape: { _deleted: true, updatedAt, originInstanceId, deletedAt }. The
// `updatedAt` is the LWW clock; `deletedAt` is the GC clock.
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

// File paths
const FILES = {
  meta: join(DATA_DIR, 'meta.json'),
  people: join(DATA_DIR, 'people.json'),
  projects: join(DATA_DIR, 'projects.json'),
  ideas: join(DATA_DIR, 'ideas.json'),
  admin: join(DATA_DIR, 'admin.json'),
  memories: join(DATA_DIR, 'memories.json'),
  links: join(DATA_DIR, 'links.json'),
  buckets: join(DATA_DIR, 'buckets.json'),
  // journals (Daily Log) and inbox are now id-keyed entity stores (see
  // BRAIN_ENTITY_TYPES) so they ride the peer-sync pipeline. journals.json keeps
  // its filename + { records: { 'YYYY-MM-DD': entry } } shape; inbox migrated
  // from the old inbox_log.jsonl to inbox.json (migration 081).
  journals: join(DATA_DIR, 'journals.json'),
  inbox: join(DATA_DIR, 'inbox.json'),
  // SongBook repertoire records (guitar tabs / chord sheets / sheet music).
  // Attachment BYTES live machine-local under data/brain/songbook/ (see
  // routes/brainSongbook.js); only the metadata rides in the synced record.
  songs: join(DATA_DIR, 'songs.json'),
  digests: join(DATA_DIR, 'digests.jsonl'),
  reviews: join(DATA_DIR, 'reviews.jsonl')
};

// Event emitter for brain data changes
export const brainEvents = new EventEmitter();

// In-memory caches
const caches = {
  meta: { data: null, timestamp: 0 },
  people: { data: null, timestamp: 0 },
  projects: { data: null, timestamp: 0 },
  ideas: { data: null, timestamp: 0 },
  admin: { data: null, timestamp: 0 },
  memories: { data: null, timestamp: 0 },
  links: { data: null, timestamp: 0 },
  buckets: { data: null, timestamp: 0 },
  journals: { data: null, timestamp: 0 },
  inbox: { data: null, timestamp: 0 },
  songs: { data: null, timestamp: 0 },
  digests: { data: null, timestamp: 0 },
  reviews: { data: null, timestamp: 0 }
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
// JSON ENTITY STORES (people, projects, ideas, admin)
// =============================================================================

/**
 * Load a JSON entity store
 */
async function loadJsonStore(type) {
  const cache = caches[type];
  if (cache.data && (Date.now() - cache.timestamp) < CACHE_TTL_MS) {
    return cache.data;
  }

  await ensureBrainDir();
  const filePath = FILES[type];

  cache.data = await readJSONFile(filePath, { records: {} });
  cache.timestamp = Date.now();
  return cache.data;
}

/**
 * Save a JSON entity store
 */
async function saveJsonStore(type, data) {
  await ensureBrainDir();
  await atomicWrite(FILES[type], data);
  caches[type].data = data;
  caches[type].timestamp = Date.now();
  brainEvents.emit(`${type}:changed`, data);
}

/**
 * Get all records from a JSON store
 */
export async function getAll(type) {
  const data = await loadJsonStore(type);
  // Tombstones (deleted markers) are excluded from all read paths — they exist
  // only to anchor the LWW sync guard, never as user-visible records.
  return Object.entries(data.records)
    .filter(([, record]) => !isTombstone(record))
    .map(([id, record]) => ({ id, ...record }));
}

/**
 * Get the RAW records map for a store, INCLUDING tombstones, keyed by id.
 *
 * Unlike `getAll` (which strips tombstones for user-facing reads), the sync
 * reconcile path needs tombstones too: they carry the LWW `updatedAt` clock a
 * peer must see to keep a delete from resurrecting. Returns a shallow copy of
 * the `{ id: record }` map — the map itself is safe to mutate, but the record
 * objects are shared with the cache by reference, so callers must treat them as
 * read-only (the reconcile path only serializes them, never mutates).
 */
export async function getRawRecords(type) {
  const data = await loadJsonStore(type);
  return { ...data.records };
}

/**
 * Get a record by ID
 */
export async function getById(type, id) {
  const data = await loadJsonStore(type);
  const record = data.records[id];
  return record && !isTombstone(record) ? { id, ...record } : null;
}

/**
 * Create a new record
 */
export async function create(type, recordData) {
  // getInstanceId() before the lock — it's an independent read, and acquiring
  // the lock first would needlessly serialize identity reads behind every write.
  const originInstanceId = await getInstanceId();
  return withStoreWriteLock(async () => {
    const data = await loadJsonStore(type);
    const id = generateId();
    const timestamp = now();

    const record = {
      ...recordData,
      originInstanceId,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    data.records[id] = record;
    await saveJsonStore(type, data);
    brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendChange('create', type, id, record, originInstanceId)
      .catch(err => console.error(`⚠️ Sync log append failed for create ${type}/${id}: ${err.message}`));

    console.log(`🧠 Created ${type} record: ${id}`);
    return { id, ...record };
  });
}

/**
 * Update a record
 */
export async function update(type, id, updates) {
  return withStoreWriteLock(async () => {
    const data = await loadJsonStore(type);

    // A tombstoned record is gone — treat it as not-found rather than reviving it.
    if (!data.records[id] || isTombstone(data.records[id])) {
      return null;
    }

    const record = {
      ...data.records[id],
      ...updates,
      // Preserve immutable fields — originInstanceId tracks the creating instance
      originInstanceId: data.records[id].originInstanceId,
      createdAt: data.records[id].createdAt,
      updatedAt: now()
    };

    data.records[id] = record;
    await saveJsonStore(type, data);
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
  // Resolve our instance id outside the lock (independent read); the existing
  // record's origin is preferred inside the lock when one is present.
  const fallbackOrigin = await getInstanceId();
  return withStoreWriteLock(async () => {
    const data = await loadJsonStore(type);
    const existing = data.records[id];
    const live = existing && !isTombstone(existing) ? existing : null;
    const timestamp = now();
    const originInstanceId = live?.originInstanceId ?? fallbackOrigin;

    const record = {
      ...recordData,
      originInstanceId,
      createdAt: live?.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    data.records[id] = record;
    await saveJsonStore(type, data);
    if (emitEvent) brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendChange(live ? 'update' : 'create', type, id, record, originInstanceId)
      .catch(err => console.error(`⚠️ Sync log append failed for upsert ${type}/${id}: ${err.message}`));

    console.log(`🧠 Upserted ${type} record: ${id}`);
    return { id, ...record };
  });
}

/**
 * Apply many record updates to one store in a single load-modify-save.
 *
 * A batch like a chip reorder must NOT fan out into N concurrent single-record
 * `update()` calls: `update()` is a read-modify-save over the whole shared JSON
 * file, so concurrent calls on a cold cache read overlapping baselines and the
 * last save wins — silently dropping the other records' changes. Collapsing the
 * batch into one load-modify-save (one file write) makes the whole reorder
 * atomic. `updates` is an array of { id, ...fields }; unknown ids are skipped.
 * Returns the updated records.
 */
export async function updateMany(type, updates) {
  return withStoreWriteLock(async () => {
    const data = await loadJsonStore(type);
    const applied = [];
    for (const { id, ...fields } of updates) {
      const existing = data.records[id];
      if (!existing || isTombstone(existing)) continue;
      const record = {
        ...existing,
        ...fields,
        // Preserve immutable fields, exactly as update() does.
        originInstanceId: existing.originInstanceId,
        createdAt: existing.createdAt,
        updatedAt: now()
      };
      data.records[id] = record;
      applied.push({ id, record });
    }
    if (applied.length === 0) return [];

    await saveJsonStore(type, data);
    for (const { id, record } of applied) {
      brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
      await brainSyncLog.appendChange('update', type, id, record, record.originInstanceId)
        .catch(err => console.error(`⚠️ Sync log append failed for update ${type}/${id}: ${err.message}`));
    }
    console.log(`🧠 Updated ${applied.length} ${type} records in one batch`);
    return applied.map(({ id, record }) => ({ id, ...record }));
  });
}

/**
 * Delete a record
 */
export async function remove(type, id) {
  return withStoreWriteLock(async () => {
    const data = await loadJsonStore(type);

    const existing = data.records[id];
    // Already gone (absent) or already tombstoned — nothing to delete, and
    // re-tombstoning would mint a redundant sync-log entry that relays needlessly.
    if (!existing || isTombstone(existing)) {
      return false;
    }

    const originInstanceId = existing.originInstanceId ?? 'unknown';
    const deletedRecord = { id, ...existing };
    const ts = now();
    // Retain a tombstone in place (not a hard delete) so a stale `create` echoed
    // from a peer is rejected by the LWW guard in applyRemoteRecord.
    data.records[id] = makeTombstone(ts, originInstanceId);
    await saveJsonStore(type, data);
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

// The inbox is now an id-keyed entity store (see BRAIN_ENTITY_TYPES) so it
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

// The inbox's concurrent same-file write paths (a capture's create immediately
// followed by a background-classification update on the same entry, plus the
// boot recovery sweep) are serialized by create/update/remove's own
// withStoreWriteLock — no separate inbox lock is needed.

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
// Batch reorder: one atomic load-modify-save so a multi-chip drag can't
// lose-update the shared links store the way N concurrent updateLink calls can.
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
 * Apply a remote record to a JSON store (last-writer-wins by updatedAt)
 */
export async function applyRemoteRecord(type, id, record, op) {
  // Reject prototype-polluting ids before they reach `data.records[id]`. JSON
  // serialization drops a `__proto__` key so there's no live data corruption,
  // but accepting it would return `applied:true` and append a phantom relay
  // entry that can never converge (the reconcile snapshot path guards this too;
  // centralizing it here covers BOTH the delta-sync and snapshot callers).
  if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
    return { applied: false, reason: 'invalid_id' };
  }
  return withStoreWriteLock(async () => {
    const data = await loadJsonStore(type);

    if (op === 'delete') {
      // Require updatedAt on delete operations for last-writer-wins conflict resolution
      if (!record?.updatedAt) {
        return { applied: false, reason: 'missing_timestamp' };
      }
      const existing = data.records[id];
      // LWW: skip if our copy (live record OR existing tombstone) is at least as
      // new as the incoming delete. The tombstone-vs-tombstone case makes a
      // repeated delete idempotent → not relayed → the echo loop converges.
      if (existing && existing.updatedAt >= record.updatedAt) {
        return { applied: false, reason: 'local_newer' };
      }
      // Tombstone in place even when no local record exists. A delete that
      // arrives before we ever saw a create still leaves a marker, so a later
      // stale create for that id is rejected instead of resurrecting.
      data.records[id] = makeTombstone(
        record.updatedAt,
        record.originInstanceId ?? existing?.originInstanceId
      );
    } else {
      // A create/update with no updatedAt has no LWW clock — `existing.updatedAt
      // >= undefined` is always false, which would let it silently overwrite a
      // tombstone and resurrect a deleted record. Reject it (mirrors the delete
      // path) so the loop-breaker can't be defeated by a timestamp-less create.
      if (!record?.updatedAt) {
        return { applied: false, reason: 'missing_timestamp' };
      }
      const existing = data.records[id];
      // Guard now also fires when `existing` is a tombstone — a stale create
      // (older updatedAt than the recorded delete) is rejected, breaking the
      // resurrection loop. A genuinely newer create (later updatedAt than the
      // tombstone) still wins and legitimately revives the record.
      if (existing && existing.updatedAt >= record.updatedAt) {
        return { applied: false, reason: 'local_newer' };
      }
      // Defense-in-depth: a create carrying `_deleted` (a future peer, or a
      // direct caller bypassing brainSync's reroute) must persist as a proper
      // tombstone, never as a malformed live record missing `deletedAt`.
      data.records[id] = record._deleted
        ? makeTombstone(record.updatedAt, record.originInstanceId ?? existing?.originInstanceId)
        : { ...record };
    }

    await ensureBrainDir();
    await atomicWrite(FILES[type], data);
    caches[type].data = data;
    caches[type].timestamp = Date.now();

    return { applied: true };
  });
}

/**
 * Hard-prune tombstones older than `cutoffMs` (a Date.now()-style epoch ms).
 * Called by the brain tombstone GC sweep on the orchestrator's interval.
 * Load-modify-save per store; writes only when something was pruned.
 * Returns the number of tombstones removed.
 */
export async function pruneTombstones(type, cutoffMs) {
  return withStoreWriteLock(async () => {
    const data = await loadJsonStore(type);
    let pruned = 0;
    for (const [id, record] of Object.entries(data.records)) {
      if (!isTombstone(record)) continue;
      const deletedAt = Date.parse(record.deletedAt ?? record.updatedAt ?? '');
      if (Number.isFinite(deletedAt) && deletedAt < cutoffMs) {
        delete data.records[id];
        pruned++;
      }
    }
    if (pruned > 0) {
      await ensureBrainDir();
      await atomicWrite(FILES[type], data);
      caches[type].data = data;
      caches[type].timestamp = Date.now();
    }
    return pruned;
  });
}

/**
 * Backfill originInstanceId on records missing it (run once at startup)
 */
export async function backfillOriginInstanceId() {
  const instanceId = await getInstanceId();
  let totalBackfilled = 0;

  for (const type of BRAIN_ENTITY_TYPES) {
    const data = await loadJsonStore(type);
    let changed = false;

    for (const [, record] of Object.entries(data.records)) {
      // Tombstones always carry originInstanceId; skip them.
      if (isTombstone(record)) continue;
      if (!record.originInstanceId) {
        record.originInstanceId = instanceId;
        changed = true;
        totalBackfilled++;
      }
    }

    if (changed) {
      await ensureBrainDir();
      await atomicWrite(FILES[type], data);
      caches[type].data = data;
      caches[type].timestamp = Date.now();
    }
  }

  if (totalBackfilled > 0) {
    console.log(`🧠 Backfilled originInstanceId on ${totalBackfilled} records`);
  }
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Invalidate all caches
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
