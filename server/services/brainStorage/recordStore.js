/**
 * Brain entity persistence, mutation events and read-through projection indexes.
 *
 * Handles file-based persistence for the Brain feature.
 * - Per-record `collectionStore` dirs for entity stores (people, projects,
 *   ideas, admin, …, journals, inbox, songs, threads) — `data/brain/<type>/<id>/index.json`
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
 * read a stale snapshot and drop the other write (the AGENTS.md-sanctioned
 * "serialize two write paths that mutate the same record" case). Writes to
 * different records no longer serialize against each other. brainJournal layers
 * its own storeMutex ON TOP for local sidecar coordination; journal transforms
 * run inside this per-id queue too, so peer applies cannot invalidate their
 * snapshot. Locks only nest storeMutex → this queue (one direction).
 *
 * FEDERATION is unaffected by the layout. Brain federates strictly per-record
 * through the storage API seams (`getRawRecords` / `applyRemoteRecord`) plus
 * the `brainSyncLog` delta log — never by shipping a whole-store file — so the
 * on-disk container shape is orthogonal to the wire format (no `schemaVersions.js`
 * gate; brain is intentionally ungated there).
 */
import { join } from 'path';
import EventEmitter from 'events';
import { v4 as uuidv4 } from '../../lib/uuid.js';
import { PATHS } from '../../lib/fileUtils.js';
import { createFileWorkFence } from '../../lib/fileWriteQueue.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { supersedingTimestamp } from '../../lib/tombstones.js';
import { getInstanceId } from '../instanceIdentity.js';
import * as brainSyncLog from '../brainSyncLog.js';

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
  'journals', 'inbox', 'songs', 'threads',
]);

// The type-level storage-layout version. Bumped by a migration that changes the
// on-disk layout; distinct from any per-record field-shape version (brain
// records carry none). Migration 200 stamps this on every brain type index.
export const BRAIN_STORE_SCHEMA_VERSION = 1;

// One collectionStore per entity type, rooted at data/brain/<type>/. No
// `sanitizeRecord` — brain records (and their in-place tombstones) are stored
// and loaded verbatim, exactly as the old monolithic map did.
const recordWrites = createFileWorkFence();
export const withLiveRecordRestore = recordWrites.exclusive;

const brainStores = Object.freeze(Object.fromEntries(
  BRAIN_ENTITY_TYPES.map((type) => [type, createCollectionStore({
    dir: join(DATA_DIR, type),
    type,
    schemaVersion: BRAIN_STORE_SCHEMA_VERSION,
    withWrite: recordWrites.run,
  })]),
));

export function storeFor(type) {
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
export const isTombstone = (rec) => !!(rec && rec._deleted);

// Build the in-place tombstone marker. `updatedAt` is the LWW clock (must be the
// delete's timestamp); `deletedAt` is the GC clock — equal at birth, kept
// separate so the GC sweep reads its own field.
export const makeTombstone = (updatedAt, originInstanceId) => ({
  _deleted: true,
  updatedAt,
  originInstanceId: originInstanceId ?? 'unknown',
  deletedAt: updatedAt,
});
// Event emitter for brain data changes
export const brainEvents = new EventEmitter();

/**
 * Announce a persisted entity-store change that did NOT emit the usual
 * `${type}:upserted` / `${type}:deleted` event.
 *
 * Some write paths are deliberately event-silent — `applyRemoteRecord` (peer
 * applies, silent to prevent the #1077 cross-peer echo loop),
 * `upsertWithId({ emitEvent: false })` (the caller emits its own richer event),
 * tombstone pruning, and origin-instance backfill. Read-through consumers did
 * not care, but derived in-memory state does: without this signal,
 * brainSearchIndex or the reconcile checksum cache could stay stale.
 *
 * LOCAL-ONLY, like `sync:applied`: it carries no record payload, is never fed
 * to the sync log, and is never relayed to a peer, so it cannot amplify an
 * echo. Listeners must treat it as "re-read this type from canonical state".
 */
export function emitRecordChanged(type, id) {
  brainEvents.emit('record:changed', { type, id });
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

// ─── Per-record projection indexes (issues #3508, #3509) ────────────────────
// A projection index answers one question about EVERY record in a store — "is
// this id live?" (#3508), "what are this link's sort/filter keys?" (#3509) —
// WITHOUT re-reading and re-parsing every record body on every call, the way
// `getAll(type)` must.
//
// Cost model per call: one `listIds()` (readdir + lstat, no body reads) plus a
// `loadOne` for ids the index has never resolved. Steady state is zero body
// reads; a store the caller has already walked answers from memory.
//
// FRESHNESS — the same three signal classes brainSearchIndex documents:
//   1. Adds and hard-deletes (create, pruneTombstones) — covered by the
//      `listIds()` diff itself; membership is re-read from disk every call.
//   2. IN-PLACE mutations that keep the id: an `archived` flip, or `remove()`
//      writing a tombstone over the record. The id survives the diff, so these
//      ride the per-record `${type}:upserted` / `${type}:deleted` events.
//   3. Event-SILENT writes — `applyRemoteRecord` (silent to prevent the #1077
//      echo loop) and `upsertWithId({ emitEvent: false })` — ride the local-only
//      `record:changed` invalidation signal.
//
// No `null = not built` sentinel is needed here (unlike brainSearchIndex):
// `listIds()` is the membership authority on every call, so an empty index is a
// legitimate "nothing resolved yet" state and never causes a redundant re-scan.
//
// Two write paths are deliberately event-silent and NOT covered by the three
// classes above, because neither can change what any projection reads:
// `pruneTombstones` hard-deletes the record dir, so the id leaves `listIds()`
// and the diff drops it; `backfillOriginInstanceId` only stamps
// `originInstanceId`, a field no projection looks at, and runs once at boot.
// A NEW projection that reads either signal must invalidate from those paths.
const RECORD_INDEX_MAX_ATTEMPTS = 3;

// Every index registers itself here so ONE invalidation drops the touched id
// from all of them — an index that missed a signal would serve a stale
// projection until the next unrelated change to that record.
const recordIndexes = [];

/**
 * Build a per-type projection index. `project(record)` maps the parsed on-disk
 * record (or `null` for a missing/corrupt one) to the value to cache for that
 * id. Registers itself for invalidation; call `resolveRecordIndex` to read it.
 */
export function createRecordIndex(project) {
  const index = {
    project,
    byType: Object.fromEntries(BRAIN_ENTITY_TYPES.map((type) => [type, new Map()])),
    // Bumped by every invalidation, so a resolve pass that raced an invalidation
    // is retried instead of writing the value it read just before the change landed.
    generation: Object.fromEntries(BRAIN_ENTITY_TYPES.map((type) => [type, 0])),
  };
  recordIndexes.push(index);
  return index;
}

function invalidateRecordIndexes(type, id) {
  if (!id) return;
  for (const index of recordIndexes) {
    const byType = index.byType[type];
    if (!byType) continue;
    byType.delete(id);
    index.generation[type] += 1;
  }
}

/**
 * Resolve a projection index for one store. Returns `[id, value]` pairs in
 * `listIds()` order — every present id, including ones whose projection is
 * `null` (callers decide what a null projection means).
 */
export async function resolveRecordIndex(indexState, type, attempt) {
  // `storeFor` throws for an unknown type, and the index maps are keyed off the
  // same BRAIN_ENTITY_TYPES list — so past this line `byType[type]` exists.
  const store = storeFor(type);
  const index = indexState.byType[type];
  const generation = indexState.generation[type];

  const ids = await store.listIds();
  const present = new Set(ids);
  for (const id of [...index.keys()]) {
    if (!present.has(id)) index.delete(id);
  }

  const unresolved = ids.filter((id) => !index.has(id));
  const loaded = await Promise.all(unresolved.map((id) => store.loadOne(id)));
  const resolved = new Map(unresolved.map((id, i) => [id, indexState.project(loaded[i])]));

  // An invalidation landed while we were reading, so what we loaded may already
  // describe the pre-change record. Re-run — the retry re-reads only the ids the
  // invalidation dropped, so it is cheap. Past the attempt ceiling we answer
  // from what we have but do NOT write it into the index: caching a value we
  // know raced would strand it there until the next change to that record.
  const raced = indexState.generation[type] !== generation;
  if (raced && attempt + 1 < RECORD_INDEX_MAX_ATTEMPTS) {
    return resolveRecordIndex(indexState, type, attempt + 1);
  }
  if (raced) {
    // Ceiling reached. The invalidation may also have dropped ids this pass
    // took FROM the index (so they were never in `unresolved`) — read those
    // before answering, or a record we merely stopped knowing about would be
    // reported as absent and undercount the result.
    const unknown = ids.filter((id) => !resolved.has(id) && !index.has(id));
    const reloaded = await Promise.all(unknown.map((id) => store.loadOne(id)));
    unknown.forEach((id, i) => resolved.set(id, indexState.project(reloaded[i])));
  } else {
    for (const [id, value] of resolved) index.set(id, value);
  }

  return ids.map((id) => [id, resolved.has(id) ? resolved.get(id) : index.get(id)]);
}

// Live = present, not a tombstone, and not archived. `loadOne` returns null for
// a missing/corrupt/unparseable record, which `getAll` also drops — so it is
// not live either.
const isLiveRecord = (record) => !!record && !isTombstone(record) && !record.archived;
const liveIdIndex = createRecordIndex(isLiveRecord);

/**
 * Ids of the LIVE records in a store — present, not tombstoned, not archived —
 * without loading record bodies for ids the index has already resolved.
 *
 * This is the cheap counterpart to `getAll(type).filter(r => !r.archived)` for
 * callers that only need identity (embedding-coverage tallies, membership
 * checks). Returns a fresh array in `listIds()` order each call.
 */
export async function listLiveIds(type) {
  const rows = await resolveRecordIndex(liveIdIndex, type, 0);
  return rows.filter(([, live]) => live === true).map(([id]) => id);
}

// Wire the freshness signals once, at module load. Invalidation only drops the
// touched id, so the next resolve re-reads exactly one record.
//
// The `journals` type is the one that needs checking rather than assuming:
// brainJournal re-emits `journals:upserted` / `journals:deleted` under the SAME
// names with its own richer `{ entry }` / `{ date, entry }` payloads, which
// carry no top-level `id`. Those extra emits are harmless no-ops here — every
// journal write still routes through brainStorage first (`putEntry` →
// `upsertWithId({ emitEvent: false })` → `record:changed`; `deleteJournal` →
// `remove()` → `journals:deleted` with `{ id }`), which is what actually
// invalidates.
for (const type of BRAIN_ENTITY_TYPES) {
  brainEvents.on(`${type}:upserted`, ({ id } = {}) => invalidateRecordIndexes(type, id));
  brainEvents.on(`${type}:deleted`, ({ id } = {}) => invalidateRecordIndexes(type, id));
}
brainEvents.on('record:changed', ({ type, id } = {}) => invalidateRecordIndexes(type, id));

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

  return store.queueRecordWrite(id, async () => {
    await store.saveOneNow(id, record);
    brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendLocalChanges([{ op: 'create', type, id, record, originInstanceId }]);
    console.log(`🧠 Created ${type} record: ${id}`);
    return { id, ...record };
  });
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
      // Local edits must outrank the version read inside this queue, even
      // within one millisecond or after receiving a peer's faster clock.
      updatedAt: supersedingTimestamp(existing.updatedAt, now())
    };

    await store.saveOneNow(id, record);
    brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendLocalChanges([{ op: 'update', type, id, record, originInstanceId: record.originInstanceId }]);

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
      updatedAt: supersedingTimestamp(existing.updatedAt, now())
    };

    await store.saveOneNow(id, record);
    brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    await brainSyncLog.appendLocalChanges([{ op: 'update', type, id, record, originInstanceId: record.originInstanceId }]);

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
 * A function receives the fresh live `{ id, ...record }` (or null) INSIDE the
 * per-id queue and returns the full replacement. Returning null/undefined
 * leaves storage, events and the sync log untouched and returns the live record.
 * Use this form for derived content and preconditions that must serialize with
 * peer applies as well as other local writes.
 * createOnly:true returns null for any existing record, including tombstones.
 */
export async function upsertWithId(type, id, recordData, { emitEvent = true, createOnly = false } = {}) {
  const store = storeFor(type);
  // A malformed id can't name a valid per-record dir — mirror the other write
  // paths and no-op rather than letting the store's write-queue assertion throw.
  if (!store.isValidId(id)) return null;
  // Resolve our instance id outside the queue (independent read); the existing
  // record's origin is preferred inside the queue when one is present.
  const fallbackOrigin = await getInstanceId();
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id);
    // Ingestion must not overwrite an edit or resurrect a tombstone.
    // Test presence inside the queue so a peer or local write cannot race.
    if (createOnly && existing) return null;
    const live = existing && !isTombstone(existing) ? existing : null;
    const input = typeof recordData === 'function'
      ? await recordData(live ? { id, ...live } : null)
      : recordData;
    if (typeof recordData === 'function' && input == null) return live ? { id, ...live } : null;
    const timestamp = now();
    const originInstanceId = live?.originInstanceId ?? fallbackOrigin;

    const record = {
      ...input,
      originInstanceId,
      createdAt: live?.createdAt ?? timestamp,
      updatedAt: supersedingTimestamp(existing?.updatedAt, timestamp)
    };

    await store.saveOneNow(id, record);
    if (emitEvent) {
      brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
    } else {
      // A suppressed per-record event still has to reach derived projections.
      emitRecordChanged(type, id);
    }
    await brainSyncLog.appendLocalChanges([{ op: live ? 'update' : 'create', type, id, record, originInstanceId }]);

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
        updatedAt: supersedingTimestamp(existing.updatedAt, now())
      };
      await store.saveOneNow(id, next);
      brainEvents.emit(`${type}:upserted`, { id, record: { id, ...next } });
      await brainSyncLog.appendLocalChanges([{ op: 'update', type, id, record: next, originInstanceId: next.originInstanceId }]);
      return next;
    });
    if (record) applied.push({ id, record });
  }
  if (applied.length === 0) return [];
  console.log(`🧠 Updated ${applied.length} ${type} records in one batch`);
  return applied.map(({ id, record }) => ({ id, ...record }));
}

/**
 * Apply a batch whose records can be persisted independently and whose sync
 * entries should be appended together. Per-record queues still protect each
 * record's read-modify-write, while Promise.allSettled lets successful writes
 * reach the batch log before a failed sibling is surfaced to the caller.
 */
export async function updateManyWithBatchLog(type, updates) {
  const store = storeFor(type);
  const results = await Promise.allSettled(updates.map(({ id, ...fields }) => {
    if (!store.isValidId(id)) return null;
    return store.queueRecordWrite(id, async () => {
      const existing = await store.loadOne(id);
      if (!existing || isTombstone(existing)) return null;

      const record = {
        ...existing,
        ...fields,
        // Preserve immutable fields, exactly as update() does.
        originInstanceId: existing.originInstanceId,
        createdAt: existing.createdAt,
        updatedAt: supersedingTimestamp(existing.updatedAt, now())
      };

      await store.saveOneNow(id, record);
      return { id, record };
    });
  }));
  const failures = results.filter(({ status }) => status === 'rejected');
  const applied = results
    .filter(({ status }) => status === 'fulfilled')
    .map(({ value }) => value)
    .filter(Boolean);

  for (const { id, record } of applied) {
    brainEvents.emit(`${type}:upserted`, { id, record: { id, ...record } });
  }

  if (applied.length > 0) {
    await brainSyncLog.appendLocalChanges(applied.map(({ id, record }) => ({
      op: 'update',
      type,
      id,
      record,
      originInstanceId: record.originInstanceId,
    })));
  }

  if (failures.length > 0) throw failures[0].reason;
  if (applied.length === 0) return [];

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
    const ts = supersedingTimestamp(existing.updatedAt, now());
    // Retain a tombstone in place (save it as the record's value, not a hard
    // delete of the record dir) so a stale `create` echoed from a peer is
    // rejected by the LWW guard in applyRemoteRecord.
    await store.saveOneNow(id, makeTombstone(ts, originInstanceId));
    brainEvents.emit(`${type}:deleted`, { id, record: deletedRecord });
    // Wire format unchanged: the sync-log delete entry still carries only
    // { updatedAt } so an older peer (no tombstone support) applies it as a
    // plain hard delete exactly as before.
    await brainSyncLog.appendLocalChanges([{ op: 'delete', type, id, record: { updatedAt: ts }, originInstanceId }]);

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

/** Ids on disk for a store, tombstones and corrupt records included. No body reads. */
export const listStoredIds = (type) => storeFor(type).listIds();

export function clearRecordIndexes() {
  for (const index of recordIndexes) {
    for (const type of BRAIN_ENTITY_TYPES) {
      index.byType[type].clear();
      index.generation[type] += 1;
    }
  }
}
