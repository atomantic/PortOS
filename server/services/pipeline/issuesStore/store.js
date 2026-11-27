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
 * The first PG-backed call runs a one-time, marker-gated import of the legacy
 * data/pipeline-issues file store into the table (migrateIssuesToDB).
 */

import { createIdValidator } from '../../../lib/recordIdValidation.js';
import { join } from 'path';
import { PATHS } from '../../../lib/fileUtils.js';
import { createCollectionStore } from '../../../lib/collectionStore.js';
import { createPgFileFacade, resolvePgBackend, isFileBackend, POSTGRES_SETUP_HINT } from '../../../lib/pgFileFacade.js';
import { createFileWriteQueue } from '../../../lib/fileWriteQueue.js';
import { bumpPipelineMutationEpoch } from '../syncEpoch.js';

// Strip history before file-backend sanitization; PG already removes it in
// SQL. Detail, exports, and inbound merge need full records. Sanitized lean
// lists still expose runHistory: [].
export const stripRunHistoryFromIssue = (issue) => {
  if (!issue || typeof issue !== 'object' || !issue.stages) return issue;
  const strippedStages = {};
  for (const [stageId, stage] of Object.entries(issue.stages)) {
    strippedStages[stageId] = stage?.runHistory?.length ? { ...stage, runHistory: [] } : stage;
  }
  return { ...issue, stages: strippedStages };
};

const TYPE_SCHEMA_VERSION = 1;
const ID_PATTERN = /^iss-[A-Za-z0-9-]+$/;

const assertValidId = createIdValidator('pipelineIssuesStore', ID_PATTERN);

function makeFileBackend(dir, sanitizeRecord) {
  const cs = createCollectionStore({
    dir,
    type: 'pipelineIssues',
    schemaVersion: TYPE_SCHEMA_VERSION,
    sanitizeRecord,
    idPattern: ID_PATTERN,
  });
  const isOldTombstone = (record, beforeMs) => record?.deleted === true && Date.parse(record.deletedAt) < beforeMs;
  return {
    name: 'file',
    readOne: (id) => cs.loadOne(id),
    // Default returns every id (incl tombstones). `includeDeleted: false` has no
    // per-record `deleted` column to filter on in the file backend, so it loads
    // raw records to drop tombstones — same "filter the full set in JS" tradeoff
    // as `listRawBySeries` below; the file backend is dev/test-only, and the PG
    // backend (production) filters via the mirrored column with no JSONB load.
    listIds: async ({ includeDeleted = true } = {}) => {
      const ids = await cs.listIds();
      if (includeDeleted) return ids;
      const records = await Promise.all(ids.map((id) => cs.loadOneRaw(id)));
      return ids.filter((_, i) => records[i] != null && records[i].deleted !== true);
    },
    getDeletionStatus: async (id) => {
      const record = await cs.loadOneRaw(id);
      return record ? record.deleted === true : null;
    },
    listSeriesIdsForIssues: async (ids) => {
      const parents = new Set();
      for (const id of ids) {
        const issue = await cs.loadOneRaw(id);
        if (issue) parents.add(issue.seriesId);
      }
      return [...parents];
    },
    listLiveIssueSeriesIds: async () => [...new Set((await cs.loadAll()).filter((r) => !r.deleted).map((r) => r.seriesId))],
    listTombstoneIdsBefore: async (beforeMs) => (await cs.loadAll()).filter((r) => isOldTombstone(r, beforeMs)).map((r) => r.id),
    deleteTombstonesBefore: async (ids, beforeMs) => {
      const removed = [];
      for (const id of ids) {
        await cs.queueRecordWrite(id, async () => {
          if (!isOldTombstone(await cs.loadOneRaw(id), beforeMs)) return;
          await cs.deleteOneNow(id);
          removed.push(id);
        });
      }
      return removed;
    },
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
    // One full scan for a set of series. This is the dev/test-only backend;
    // production uses the indexed multi-series PostgreSQL query below.
    listRawBySeriesIds: async (seriesIds) => {
      if (seriesIds.length === 0) return [];
      const wanted = new Set(seriesIds);
      const ids = await cs.listIds();
      const records = await Promise.all(ids.map((id) => cs.loadOneRaw(id)));
      return records.filter((r) => r != null && wanted.has(r.seriesId));
    },
    writeRaw: (id, record) => cs.saveOne(id, record),
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
    getDeletionStatus: db.getDeletionStatus,
    listLiveIssueSeriesIds: db.listLiveIssueSeriesIds,
    listSeriesIdsForIssues: db.listSeriesIdsForIssues,
    listTombstoneIdsBefore: db.listTombstoneIdsBefore,
    deleteTombstonesBefore: db.deleteTombstonesBefore,
    listRaw: db.listRaw,
    listRawBySeries: db.listRawBySeries,
    listRawBySeriesIds: db.listRawBySeriesIds,
    writeRaw: db.writeRaw,
    deleteRaw: db.deleteRaw,
    verify: async () => ({ ok: true, type: 'pipelineIssues', onDisk: null, expected: null,
      message: 'collection "pipelineIssues" @ postgres (#1015)' }),
  };
}

const pgBackend = (sanitizeRecord) => resolvePgBackend({
  requirement: `Pipeline issues require PostgreSQL — ${POSTGRES_SETUP_HINT}`,
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
  // Retained for collection-store callers. Issue service mutations share the
  // per-series and per-id tails in issuesShared.
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

  const sanitizeList = (raw, { withHistory = true } = {}) => raw
    .map((r) => sanitizer(withHistory ? r : stripRunHistoryFromIssue(r)))
    .filter((r) => r != null);

  return {
    dir,
    type: 'pipelineIssues',
    getBackendName,

    listSeriesIdsForIssues: async (ids) => (await getBackend()).listSeriesIdsForIssues(ids),
    listIds: async (opts) => (await getBackend()).listIds(opts),
    getDeletionStatus: async (id) => (await getBackend()).getDeletionStatus(id),
    listLiveIssueSeriesIds: async () => (await getBackend()).listLiveIssueSeriesIds(),
    listTombstoneIdsBefore: async (beforeMs) => (await getBackend()).listTombstoneIdsBefore(beforeMs),
    deleteTombstonesBefore: async (ids, beforeMs) => {
      const removed = await (await getBackend()).deleteTombstonesBefore(ids, beforeMs);
      if (removed.length) bumpPipelineMutationEpoch();
      return removed;
    },
    loadOne: async (id) => {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
      return (await getBackend()).readOne(id);
    },
    loadAll: async (options) => {
      const raw = await (await getBackend()).listRaw(options);
      return sanitizeList(raw, options);
    },
    loadAllForSeries: async (seriesId, options) => {
      const raw = await (await getBackend()).listRawBySeries(seriesId, options);
      return sanitizeList(raw, options);
    },
    loadAllForSeriesIds: async (seriesIds, options) => {
      const raw = await (await getBackend()).listRawBySeriesIds(seriesIds, options);
      return sanitizeList(raw, options);
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
