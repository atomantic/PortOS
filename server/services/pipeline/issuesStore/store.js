/**
 * Pipeline issues — storage backend dispatcher (#1015).
 *
 * Issues used to live one-record-per-dir under
 * data/pipeline-issues/{id}/index.json (collectionStore). As of #1015 they live
 * one-row-per-issue in PostgreSQL (`pipeline_issues`). This facade is a DROP-IN
 * for the `createCollectionStore` surface issues.js already calls (loadAll /
 * loadOne / saveOneNow / deleteOne / queueTypeIndexWrite / verifySchemaVersion),
 * so the service keeps its public API and only its `store()` factory changes. It
 * owns the in-process serialization + the sanitizer and delegates leaf I/O to a
 * memoized backend (PostgreSQL ./db.js, or collectionStore file backend under
 * MEMORY_BACKEND=file / NODE_ENV=test).
 *
 * Federation invisibility: every record write/delete bumps the shared pipeline
 * MUTATION EPOCH (../syncEpoch.js) — see seriesStore/store.js for the rationale.
 *
 * `queueTypeIndexWrite` keeps the single-tail "one consistent merge snapshot"
 * semantics issues.js relies on for mergeIssuesFromSync / pruneTombstonedIssues
 * (those read the whole issue set, mutate, and write back; they must serialize
 * against themselves). It's a process-local promise tail — backend-agnostic.
 *
 * The first PG-backed call runs a one-time, marker-gated import of the legacy
 * data/pipeline-issues file store into the table (migrateIssuesToDB).
 */

import { join } from 'path';
import { PATHS } from '../../../lib/fileUtils.js';
import { createCollectionStore } from '../../../lib/collectionStore.js';
import { createPgFileFacade, resolvePgBackend, isFileBackend } from '../../../lib/pgFileFacade.js';
import { createFileWriteQueue } from '../../../lib/fileWriteQueue.js';
import { bumpPipelineMutationEpoch } from '../syncEpoch.js';

const TYPE_SCHEMA_VERSION = 1;
const ID_PATTERN = /^iss-[A-Za-z0-9-]+$/;

function assertValidId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error(`pipelineIssuesStore: invalid record id "${id}" — must match ${ID_PATTERN}`);
  }
}

function makeFileBackend(dir, sanitizeRecord) {
  const cs = createCollectionStore({
    dir,
    type: 'pipelineIssues',
    schemaVersion: TYPE_SCHEMA_VERSION,
    sanitizeRecord,
    idPattern: ID_PATTERN,
  });
  return {
    name: 'file',
    readOne: (id) => cs.loadOne(id),
    listIds: () => cs.listIds(),
    listRaw: async () => {
      const ids = await cs.listIds();
      const records = await Promise.all(ids.map((id) => cs.loadOneRaw(id)));
      return records.filter((r) => r != null);
    },
    // No per-series index in the file backend — filter the full set in JS. The
    // PG backend below uses an indexed WHERE; this keeps the facade uniform.
    listRawBySeries: async (seriesId) => {
      const ids = await cs.listIds();
      const records = await Promise.all(ids.map((id) => cs.loadOneRaw(id)));
      return records.filter((r) => r != null && r.seriesId === seriesId);
    },
    writeRaw: (id, record) => cs.saveOneNow(id, record),
    deleteRaw: (id) => cs.deleteOneNow(id),
    verify: () => cs.verifySchemaVersion(),
  };
}

function makePgBackend(db, sanitizeRecord) {
  return {
    name: 'postgres',
    readOne: async (id) => {
      const raw = await db.readRaw(id);
      return raw ? sanitizeRecord(raw) : null;
    },
    listIds: db.listIds,
    listRaw: db.listRaw,
    listRawBySeries: db.listRawBySeries,
    writeRaw: db.writeRaw,
    deleteRaw: db.deleteRaw,
    verify: async () => ({ ok: true, type: 'pipelineIssues', onDisk: null, expected: null,
      message: 'collection "pipelineIssues" @ postgres (#1015)' }),
  };
}

const pgBackend = (sanitizeRecord) => resolvePgBackend({
  requirement: 'Pipeline issues require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
  migrate: async () => {
    const { migrateIssuesToDB } = await import('../../../scripts/migrateIssuesToDB.js');
    await migrateIssuesToDB();
  },
  loadDb: () => import('./db.js'),
  makePg: (db) => makePgBackend(db, sanitizeRecord),
});

function createFacade({ dir, sanitizeRecord }) {
  const sanitizer = typeof sanitizeRecord === 'function' ? sanitizeRecord : (r) => r;

  const { getBackend, getBackendName } = createPgFileFacade({
    makeFile: () => makeFileBackend(dir, sanitizer),
    makePg: () => pgBackend(sanitizer),
  });

  // Single-tail type-index queue — mirrors collectionStore.queueTypeIndexWrite.
  // mergeIssuesFromSync / pruneTombstonedIssues load the whole issue set, mutate,
  // and write back; they must serialize against themselves for one consistent
  // merge snapshot.
  const queueTypeIndexWrite = createFileWriteQueue();

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
    type: 'pipelineIssues',
    getBackendName,

    listIds: async () => (await getBackend()).listIds(),
    loadOne: async (id) => {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
      return (await getBackend()).readOne(id);
    },
    loadAll: async () => {
      const raw = await (await getBackend()).listRaw();
      return raw.map((r) => sanitizer(r)).filter((r) => r != null);
    },
    loadAllForSeries: async (seriesId) => {
      const raw = await (await getBackend()).listRawBySeries(seriesId);
      return raw.map((r) => sanitizer(r)).filter((r) => r != null);
    },

    saveOneNow,
    deleteOneNow,
    deleteOne: deleteOneNow, // issues delete from inside queueTypeIndexWrite / Promise.all batches

    queueTypeIndexWrite,

    verifySchemaVersion: async () => {
      if (!isFileBackend()) {
        return { ok: true, type: 'pipelineIssues', onDisk: null, expected: null,
          message: 'collection "pipelineIssues" @ postgres (#1015)' };
      }
      return (await getBackend()).verify();
    },
  };
}

let _facade = null;
let _facadeDir = null;

/**
 * Get the issues store facade. Pass the record sanitizer (sanitizeIssue) so
 * loadOne/loadAll return sanitized records. Synchronous — backend selection is
 * deferred into each method.
 */
export function getIssuesStore(sanitizeRecord) {
  const dir = join(PATHS.data, 'pipeline-issues');
  if (_facade && _facadeDir === dir) return _facade;
  _facade = createFacade({ dir, sanitizeRecord });
  _facadeDir = dir;
  return _facade;
}

/** Reset the memoized facade — test seam only (does NOT reset the epoch). */
export function _resetIssuesStore() {
  _facade = null;
  _facadeDir = null;
}
