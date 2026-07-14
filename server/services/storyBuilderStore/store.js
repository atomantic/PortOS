/**
 * Story Builder sessions — storage backend dispatcher (#1016).
 *
 * Sessions used to live one-record-per-dir under
 * data/story-builder/{id}/index.json (collectionStore). As of #1016 they live
 * one-row-per-session in PostgreSQL (`story_builder_sessions`). This facade is a
 * DROP-IN for the `createCollectionStore` surface storyBuilder.js already calls
 * (loadAll / loadOne / queueRecordWrite / saveOne / saveOneNow / verifySchemaVersion),
 * so the service keeps its public API and only its `store()` factory changes. It
 * owns the in-process serialization (per-id write queue) + the sanitizer, and
 * delegates only leaf I/O to a memoized backend:
 *
 *   - PostgreSQL (./db.js) for normal installs.
 *   - File (collectionStore) only under MEMORY_BACKEND=file or NODE_ENV=test —
 *     both UNSUPPORTED for production. Tests boot without a DB, so they keep
 *     exercising the per-record file store exactly as before.
 *
 * Federation invisibility (D2 of the schema-design doc): dataSync decides WHEN to
 * re-send the storyBuilder snapshot by fingerprinting the data/story-builder
 * directory. A PG-backed session edit no longer touches that directory, so the
 * module-level MUTATION EPOCH below is bumped on every record write/delete;
 * dataSync folds it into the storyBuilder fingerprint, keeping the storage swap
 * invisible to peers. Sessions hold ONLY index.json (no file-primary siblings),
 * so — unlike the series store — there is no on-disk `recordDir` to preserve.
 *
 * The first PG-backed call runs a one-time, marker-gated import of the legacy
 * data/story-builder file store into the table (migrateStoryBuilderToDB).
 */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { createPgFileFacade, resolvePgBackend, isFileBackend } from '../../lib/pgFileFacade.js';
import { createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import { bumpChangeToken, getChangeToken } from '../changeToken.js';

// TYPE-level (storage layout) schema version stamped on the file backend's
// data/story-builder/index.json — preserved so an install on the file escape
// hatch still passes the boot verifier. (PG has no type-index file.)
const TYPE_SCHEMA_VERSION = 1;
const ID_PATTERN = /^stb-[A-Za-z0-9-]+$/;

function assertValidId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`storyBuilderStore: invalid record id "${id}" — must match ${ID_PATTERN}`);
  }
}

// --- Mutation epoch (the dataSync federation-invisibility fix, #1031) ---
// Backed by the shared change-token registry (../changeToken.js) — a single
// domain-keyed monotonic counter that survives facade rebuilds (test PATHS.data
// swaps). Bumped on every record write/delete. Thin wrapper kept so call sites /
// tests don't all rewire.
/** Current Story Builder mutation epoch — folded into dataSync's fingerprint. */
export function getStoryBuilderMutationEpoch() {
  return getChangeToken('storyBuilder');
}

// --- File backend (escape hatch / tests): wraps collectionStore ---
function makeFileBackend(dir, sanitizeRecord) {
  const cs = createCollectionStore({
    dir,
    type: 'storyBuilder',
    schemaVersion: TYPE_SCHEMA_VERSION,
    sanitizeRecord,
    idPattern: ID_PATTERN,
  });
  return {
    name: 'file',
    readRaw: (id) => cs.loadOneRaw(id),
    readOne: (id) => cs.loadOne(id),
    listIds: () => cs.listIds(),
    listRaw: async () => {
      const ids = await cs.listIds();
      const records = await Promise.all(ids.map((id) => cs.loadOneRaw(id)));
      return records.filter((r) => r != null);
    },
    writeRaw: (id, record) => cs.saveOneNow(id, record),
    deleteRaw: (id) => cs.deleteOneNow(id),
    verify: () => cs.verifySchemaVersion(),
  };
}

// --- PostgreSQL backend: pure leaf I/O from ./db.js ---
function makePgBackend(db, sanitizeRecord) {
  return {
    name: 'postgres',
    readRaw: db.readRaw,
    readOne: async (id) => {
      const raw = await db.readRaw(id);
      return raw ? sanitizeRecord(raw) : null;
    },
    listIds: db.listIds,
    listRaw: db.listRaw,
    writeRaw: db.writeRaw,
    deleteRaw: db.deleteRaw,
    verify: async () => ({ ok: true, type: 'storyBuilder', onDisk: null, expected: null,
      message: 'collection "storyBuilder" @ postgres (#1016)' }),
  };
}

const pgBackend = (sanitizeRecord) => resolvePgBackend({
  requirement: 'Story Builder requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
  migrate: async () => {
    const { migrateStoryBuilderToDB } = await import('../../scripts/migrateStoryBuilderToDB.js');
    await migrateStoryBuilderToDB();
  },
  loadDb: () => import('./db.js'),
  makePg: (db) => makePgBackend(db, sanitizeRecord),
});

// --- Facade: collectionStore-compatible, queues + epoch + sanitize ---
function createFacade({ dir, sanitizeRecord }) {
  let sanitizer = typeof sanitizeRecord === 'function' ? sanitizeRecord : (r) => r;

  // Backend selection is memoized (promise, not just result) so two concurrent
  // first calls — e.g. the boot warm racing a sync pull — don't both import the
  // PG module and run the migration twice. `sanitizer` is read at selection time.
  const { getBackend, getBackendName } = createPgFileFacade({
    makeFile: () => makeFileBackend(dir, sanitizer),
    makePg: () => pgBackend(sanitizer),
  });

  // Per-id write queue — mirrors collectionStore.queueRecordWrite.
  const queueRecordWrite = createRecordWriteQueue(assertValidId);

  const loadOne = async (id) => {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
    return (await getBackend()).readOne(id);
  };

  const saveOneNow = async (id, record) => {
    assertValidId(id);
    const out = await (await getBackend()).writeRaw(id, record);
    bumpChangeToken('storyBuilder');
    return out ?? record;
  };

  const deleteOneNow = async (id) => {
    assertValidId(id);
    await (await getBackend()).deleteRaw(id);
    bumpChangeToken('storyBuilder');
  };

  return {
    dir,
    type: 'storyBuilder',
    _setSanitizer: (fn) => { if (typeof fn === 'function') sanitizer = fn; },
    getBackendName,

    // Reads (sanitized, matching collectionStore.loadOne/loadAll)
    listIds: async () => (await getBackend()).listIds(),
    loadOne,
    loadOneRaw: async (id) => {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
      return (await getBackend()).readRaw(id);
    },
    loadAll: async () => {
      const raw = await (await getBackend()).listRaw();
      return raw.map((r) => sanitizer(r)).filter((r) => r != null);
    },

    // Writes
    queueRecordWrite,
    saveOneNow,
    saveOne: (id, record) => queueRecordWrite(id, () => saveOneNow(id, record)),
    deleteOneNow,
    deleteOne: (id) => queueRecordWrite(id, () => deleteOneNow(id)),

    // Boot-time verifier. Under PG return ok WITHOUT forcing backend selection
    // (the early boot verifier runs before the dbReady gate; the authoritative
    // warm in index.js selects the backend at the right time).
    verifySchemaVersion: async () => {
      if (!isFileBackend()) {
        return { ok: true, type: 'storyBuilder', onDisk: null, expected: null,
          message: 'collection "storyBuilder" @ postgres (#1016)' };
      }
      return (await getBackend()).verify();
    },
  };
}

let _facade = null;
let _facadeDir = null;

/**
 * Get the Story Builder store facade. Pass the record sanitizer
 * (sanitizeSession) so loadOne/loadAll return sanitized records without store.js
 * importing the service (which would close a cycle). Synchronous — backend
 * selection is deferred into each method.
 */
export function getStoryBuilderStore(sanitizeRecord) {
  const dir = join(PATHS.data, 'story-builder');
  if (_facade && _facadeDir === dir) {
    if (sanitizeRecord) _facade._setSanitizer(sanitizeRecord);
    return _facade;
  }
  _facade = createFacade({ dir, sanitizeRecord });
  _facadeDir = dir;
  return _facade;
}

/** Reset the memoized facade — test seam only (does NOT reset the epoch). */
export function _resetStoryBuilderStore() {
  _facade = null;
  _facadeDir = null;
}
