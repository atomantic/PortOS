/**
 * Universe Builder — storage backend dispatcher (#1014).
 *
 * Universes used to live one-record-per-dir under data/universes/{id}/index.json
 * (collectionStore). As of #1014 they live one-row-per-universe in PostgreSQL
 * (`universes` + `universe_runs`). This facade keeps `store()` SYNCHRONOUS — the
 * 2000-line service calls it everywhere and then awaits the returned methods —
 * by owning the in-process serialization (per-id write queue + a single-tail run
 * queue) and the sanitizer, and delegating only leaf I/O to a memoized backend:
 *
 *   - PostgreSQL (./db.js) for normal installs.
 *   - File (collectionStore) only under MEMORY_BACKEND=file or NODE_ENV=test —
 *     both UNSUPPORTED for production. Tests boot without a DB, so they keep
 *     exercising the per-record file store exactly as before.
 *
 * Federation invisibility (D2 of the schema-design doc): dataSync decides WHEN to
 * re-send the universe snapshot to peers by fingerprinting the data/universes
 * directory (mtime:size:inode). A PG-backed universe edit no longer touches that
 * directory, so without help the snapshot cache would never invalidate and peers
 * would silently stop receiving universe edits. The fix is the module-level
 * MUTATION EPOCH below: every record write/delete bumps it, dataSync folds it
 * into the universe + mediaCollections fingerprint, and the storage swap stays
 * invisible to the federation layer. Run writes are local-only (stripped from the
 * wire) so they deliberately do NOT bump the sync epoch.
 *
 * The first PG-backed call runs a one-time, marker-gated import of the legacy
 * data/universes file store into the tables (migrateUniversesToDB), so the boot
 * warm — the first caller — sees migrated records.
 */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { createPgFileFacade, resolvePgBackend, isFileBackend } from '../../lib/pgFileFacade.js';
import { createFileWriteQueue, createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import { bumpChangeToken, getChangeToken } from '../changeToken.js';

// TYPE-level (storage layout) schema version stamped on the file backend's
// data/universes/index.json — preserved so an install on the file escape hatch
// still passes the boot verifier. (PG has no type-index file; see verify().)
const TYPE_SCHEMA_VERSION = 5;

// Record-id allowlist — IDENTICAL to the collectionStore idPattern the file
// backend enforced. The facade must reject the same ids on the PG path so the
// two backends accept the same records: a malformed synced/imported id (e.g.
// `bad/id`, or >128 chars) that the file store threw on must NOT silently land
// in the `universes` table (where it can't round-trip back to files and could
// break path/route consumers). queueRecordWrite/writeRecord/deleteRecord throw
// on a bad id, so mergeUniversesFromSync's per-id `.catch` skips it exactly as
// it did against the file backend.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** True when `id` matches the universe record-id allowlist (collectionStore parity). */
export const isValidUniverseId = (id) => typeof id === 'string' && ID_PATTERN.test(id);
const isValidId = isValidUniverseId;
function assertValidId(id) {
  if (!isValidId(id)) {
    throw new Error(`universeStore: invalid record id "${id}" — must match ${ID_PATTERN}`);
  }
}

// --- Mutation epoch (the dataSync federation-invisibility fix, #1031) ---
// Backed by the shared change-token registry (../changeToken.js) — a single
// domain-keyed monotonic counter that survives facade rebuilds (test PATHS.data
// swaps). Bumped on every record write/delete (NOT run writes — those are
// local-only). Thin wrapper kept so call sites / tests don't all rewire.
/** Current universe mutation epoch — folded into dataSync's fingerprint. */
export function getUniverseMutationEpoch() {
  return getChangeToken('universe');
}

// --- File backend (escape hatch / tests): wraps collectionStore ---
// No sanitizer on the collectionStore — the facade owns sanitize uniformly so
// loadOneRaw and loadOne share one code path. Runs writes use saveTypeIndex,
// whose internal queue is harmless because the facade already serializes every
// run write on its own run-tail.
function makeFileBackend(dir) {
  const cs = createCollectionStore({
    dir,
    type: 'universes',
    schemaVersion: TYPE_SCHEMA_VERSION,
    idPattern: /^[A-Za-z0-9_-]{1,128}$/,
  });
  const runsOf = (ti) => (Array.isArray(ti.config?.runs) ? ti.config.runs : []);
  const listRaw = async () => {
    const ids = await cs.listIds();
    const records = await Promise.all(ids.map((id) => cs.loadOneRaw(id)));
    return records.filter((r) => r != null);
  };
  return {
    name: 'file',
    readRaw: (id) => cs.loadOneRaw(id),
    listIds: () => cs.listIds(),
    listRaw,
    // There is no cheap count on the file layout — `deleted` lives INSIDE each
    // record, so knowing which ids are live means reading them all (listIds()
    // alone can't tell). This still skips what made listUniverses() expensive:
    // the run-history load and the per-record sanitize+sort. Matches the PG
    // backend's semantics — `deleted !== true` is exactly the predicate
    // sanitizeSoftDeleteFields applies before listUniverses filters on it.
    countUniverses: async ({ includeDeleted = false } = {}) => {
      const records = await listRaw();
      return includeDeleted ? records.length : records.filter((r) => r?.deleted !== true).length;
    },
    writeRaw: (id, record) => cs.saveOneNow(id, record),
    deleteRaw: (id) => cs.deleteOneNow(id),
    loadRuns: async (universeId = null) => {
      const ti = await cs.loadTypeIndex();
      const runs = runsOf(ti);
      const scoped = universeId ? runs.filter((r) => r?.universeId === universeId) : runs;
      // Match the PG backend's `created_at DESC, id DESC` order so the two
      // backends return runs identically (the service's listRuns re-sorts by
      // createdAt anyway, but a direct facade consumer shouldn't see backend-
      // dependent order). Copy before sort — runsOf returns the live array.
      return [...scoped].sort((a, b) =>
        (b?.createdAt || '').localeCompare(a?.createdAt || '')
        || (b?.id || '').localeCompare(a?.id || ''));
    },
    appendRun: async (run) => {
      const ti = await cs.loadTypeIndex();
      const runs = [...runsOf(ti), run];
      const capped = runs.length > 200 ? runs.slice(-200) : runs;
      await cs.saveTypeIndex({ config: { runs: capped } });
    },
    removeRunsForUniverses: async (universeIds) => {
      const drop = new Set(universeIds || []);
      const ti = await cs.loadTypeIndex();
      const filtered = runsOf(ti).filter((r) => !drop.has(r?.universeId));
      await cs.saveTypeIndex({ config: { runs: filtered } });
    },
    verify: () => cs.verifySchemaVersion(),
  };
}

// --- PostgreSQL backend: pure leaf I/O from ./db.js ---
function makePgBackend(db) {
  return {
    name: 'postgres',
    readRaw: db.readRaw,
    listIds: db.listIds,
    listRaw: db.listRaw,
    countUniverses: db.countUniverses,
    writeRaw: db.writeRaw,
    deleteRaw: db.deleteRaw,
    loadRuns: db.loadRuns,
    appendRun: db.appendRun,
    removeRunsForUniverses: db.removeRunsForUniverses,
    // PG has no type-index file; the DDL + one-time import ARE the layout
    // version gate. Report ok so the boot verifier stays quiet on PG installs.
    verify: async () => ({ ok: true, type: 'universes', onDisk: null, expected: null,
      message: 'collection "universes" @ postgres (#1014)' }),
  };
}

// Self-sufficient like the catalog-user-types backend: the boot DB gate
// fail-fasts a required-but-missing DB, but the early universe warm / a sync
// pull can call in BEFORE that gate's ensureSchema() runs — so resolvePgBackend
// brings the schema up (idempotent) and runs the one-time file→DB import first.
const pgBackend = () => resolvePgBackend({
  requirement: 'Universe Builder requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
  migrate: async () => {
    const { migrateUniversesToDB } = await import('../../scripts/migrateUniversesToDB.js');
    await migrateUniversesToDB();
  },
  loadDb: () => import('./db.js'),
  makePg: (db) => makePgBackend(db),
});

// --- Facade: sync object, queues + epoch + sanitize, async backend delegation ---
function createFacade({ dir, sanitizeRecord }) {
  let sanitizer = typeof sanitizeRecord === 'function' ? sanitizeRecord : (r) => r;

  // Backend selection is memoized (promise, not just result) so two concurrent
  // first calls — e.g. the boot warm racing a sync pull — don't both import the
  // PG module and run the migration twice.
  const { getBackend, getBackendName } = createPgFileFacade({
    makeFile: () => makeFileBackend(dir),
    makePg: () => pgBackend(),
  });

  // Per-id write queue — tail-chained per id so two RMW cycles on the SAME id
  // serialize while different ids fan out in parallel. Backend-agnostic so file
  // and PG serialize identically. Mirrors collectionStore's queueRecordWrite.
  const queueRecordWrite = createRecordWriteQueue(assertValidId);

  // Single-tail queue for run-log writes (append / cascade-remove). The runs log
  // is shared cross-record state, so its RMW must serialize against itself.
  const queueRunWrite = createFileWriteQueue();

  return {
    dir,
    type: 'universes',
    _setSanitizer: (fn) => { if (typeof fn === 'function') sanitizer = fn; },
    getBackendName,

    // Reads
    listIds: async () => (await getBackend()).listIds(),
    listRaw: async () => (await getBackend()).listRaw(),
    countUniverses: async (opts) => (await getBackend()).countUniverses(opts),
    loadOneRaw: async (id) => (await getBackend()).readRaw(id),
    loadOne: async (id) => {
      const raw = await (await getBackend()).readRaw(id);
      return raw ? sanitizer(raw) : null;
    },

    // Per-id write serialization (callers run their RMW inside this)
    queueRecordWrite,

    // Backend-agnostic record persistence — replaces the inline
    // ensureDir+atomicWrite(recordPath) / rm(recordDir) the service used to do.
    // Both bump the mutation epoch so dataSync re-sends the universe snapshot.
    writeRecord: async (id, record) => {
      assertValidId(id); // parity with collectionStore.saveOneNow — reject bad ids on BOTH backends
      const out = await (await getBackend()).writeRaw(id, record);
      bumpChangeToken('universe');
      return out ?? record;
    },
    deleteRecord: async (id) => {
      assertValidId(id); // parity with collectionStore.deleteOneNow
      await (await getBackend()).deleteRaw(id);
      bumpChangeToken('universe');
    },

    // Render-history runs (local-only — no epoch bump)
    loadRuns: async (universeId = null) => (await getBackend()).loadRuns(universeId),
    appendRun: (run) => queueRunWrite(async () => (await getBackend()).appendRun(run)),
    removeRunsForUniverses: (ids) =>
      queueRunWrite(async () => (await getBackend()).removeRunsForUniverses(ids)),

    // Boot-time verifier. Under the file backend it reads the on-disk type
    // index. Under PG it returns ok WITHOUT forcing backend selection — the
    // early boot verifier runs before the dbReady gate, and we don't want to
    // trigger the one-time import there; the authoritative warm in the dbReady
    // block (server/index.js) selects the backend at the right time. The env
    // check is cheap and matches the selection predicate.
    verifySchemaVersion: async () => {
      if (!isFileBackend()) {
        return { ok: true, type: 'universes', onDisk: null, expected: null,
          message: 'collection "universes" @ postgres (#1014)' };
      }
      return (await getBackend()).verify();
    },
  };
}

// Memoized facade, keyed by data dir so test harnesses that swap PATHS.data
// per-test (mkdtempSync + Proxy mock) still see the right root.
let _facade = null;
let _facadeDir = null;

/**
 * Get the universe store facade. Pass the record sanitizer (sanitizeTemplate)
 * so `loadOne` returns a sanitized record without store.js importing the service
 * (which would close a cycle). Synchronous — backend selection is deferred into
 * each method.
 */
export function getUniverseStore(sanitizeRecord) {
  const dir = join(PATHS.data, 'universes');
  if (_facade && _facadeDir === dir) {
    if (sanitizeRecord) _facade._setSanitizer(sanitizeRecord);
    return _facade;
  }
  _facade = createFacade({ dir, sanitizeRecord });
  _facadeDir = dir;
  return _facade;
}

/** Reset the memoized facade — test seam only (does NOT reset the epoch). */
export function _resetUniverseStore() {
  _facade = null;
  _facadeDir = null;
}
