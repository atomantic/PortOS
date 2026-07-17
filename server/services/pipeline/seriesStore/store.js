/**
 * Pipeline series — storage backend dispatcher (#1015).
 *
 * Series used to live one-record-per-dir under
 * data/pipeline-series/{id}/index.json (collectionStore). As of #1015 they live
 * one-row-per-series in PostgreSQL (`pipeline_series`). This facade is a
 * DROP-IN for the `createCollectionStore` surface series.js already calls
 * (loadAll / loadOne / queueRecordWrite / saveOne / saveOneNow / deleteOneNow /
 * recordDir / verifySchemaVersion), so the service keeps its public API and only
 * its `store()` factory changes. It owns the in-process serialization (per-id
 * write queue) + the sanitizer, and delegates only leaf I/O to a memoized
 * backend:
 *
 *   - PostgreSQL (./db.js) for normal installs.
 *   - File (collectionStore) only under MEMORY_BACKEND=file or NODE_ENV=test —
 *     both UNSUPPORTED for production. Tests boot without a DB, so they keep
 *     exercising the per-record file store exactly as before.
 *
 * Federation invisibility (D2 of the schema-design doc): dataSync decides WHEN to
 * re-send the pipeline snapshot by fingerprinting the data/pipeline-series +
 * data/pipeline-issues directories. A PG-backed series edit no longer touches
 * those directories, so the shared pipeline MUTATION EPOCH (./syncEpoch.js) is
 * bumped on every record write/delete; dataSync folds it into the pipeline +
 * mediaCollections fingerprints, keeping the storage swap invisible to peers.
 *
 * `recordDir(id)` ALWAYS returns the on-disk path
 * data/pipeline-series/{id} regardless of backend — the series'
 * `manuscript-review.json` sibling doc is `file-primary` and stays on disk
 * (manuscriptReview.js reads/writes it there). Only the series record itself
 * (index.json) moved to PG.
 *
 * The first PG-backed call runs a one-time, marker-gated import of the legacy
 * data/pipeline-series file store into the table (migrateSeriesToDB), leaving
 * the manuscript-review.json siblings in place.
 */

import { join } from 'path';
import { PATHS } from '../../../lib/fileUtils.js';
import { createCollectionStore } from '../../../lib/collectionStore.js';
import { createPgFileFacade, resolvePgBackend, isFileBackend } from '../../../lib/pgFileFacade.js';
import { createRecordWriteQueue } from '../../../lib/fileWriteQueue.js';
import { bumpPipelineMutationEpoch } from '../syncEpoch.js';

// TYPE-level (storage layout) schema version stamped on the file backend's
// data/pipeline-series/index.json — preserved so an install on the file escape
// hatch still passes the boot verifier. (PG has no type-index file.)
const TYPE_SCHEMA_VERSION = 1;
const ID_PATTERN = /^ser-[A-Za-z0-9-]+$/;

function assertValidId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`pipelineSeriesStore: invalid record id "${id}" — must match ${ID_PATTERN}`);
  }
}

// --- File backend (escape hatch / tests): wraps collectionStore ---
function makeFileBackend(dir, sanitizeRecord) {
  const cs = createCollectionStore({
    dir,
    type: 'pipelineSeries',
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
    verify: async () => ({ ok: true, type: 'pipelineSeries', onDisk: null, expected: null,
      message: 'collection "pipelineSeries" @ postgres (#1015)' }),
  };
}

const pgBackend = (sanitizeRecord) => resolvePgBackend({
  requirement: 'Pipeline series require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
  migrate: async () => {
    const { migrateSeriesToDB } = await import('../../../scripts/migrateSeriesToDB.js');
    await migrateSeriesToDB();
  },
  loadDb: () => import('./db.js'),
  makePg: (db) => makePgBackend(db, sanitizeRecord),
});

// --- Facade: collectionStore-compatible, queues + epoch + sanitize ---
function createFacade({ dir, sanitizeRecord }) {
  const sanitizer = typeof sanitizeRecord === 'function' ? sanitizeRecord : (r) => r;

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
    bumpPipelineMutationEpoch();
    return out ?? record;
  };

  const deleteOneNow = async (id) => {
    assertValidId(id);
    await (await getBackend()).deleteRaw(id);
    bumpPipelineMutationEpoch();
  };

  return {
    dir,
    type: 'pipelineSeries',
    // recordDir ALWAYS resolves to the on-disk path — the manuscript-review.json
    // sibling is file-primary and lives there regardless of the record backend.
    recordDir: (id) => join(dir, id),
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
        return { ok: true, type: 'pipelineSeries', onDisk: null, expected: null,
          message: 'collection "pipelineSeries" @ postgres (#1015)' };
      }
      return (await getBackend()).verify();
    },
  };
}

let _facade = null;
let _facadeDir = null;

/**
 * Get the series store facade. Pass the record sanitizer (sanitizeSeries) so
 * loadOne/loadAll return sanitized records without store.js importing the
 * service (which would close a cycle). Synchronous — backend selection is
 * deferred into each method.
 */
export function getSeriesStore(sanitizeRecord) {
  const dir = join(PATHS.data, 'pipeline-series');
  if (_facade && _facadeDir === dir) return _facade;
  _facade = createFacade({ dir, sanitizeRecord });
  _facadeDir = dir;
  return _facade;
}

/** Reset the memoized facade — test seam only (does NOT reset the epoch). */
export function _resetSeriesStore() {
  _facade = null;
  _facadeDir = null;
}
