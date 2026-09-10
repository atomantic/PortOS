/**
 * FableLoom records — PostgreSQL/file backend facade.
 *
 * Looms are db-primary in normal installs (`fableloom_stories`). The
 * collectionStore backend keeps the domain runnable in tests and under the
 * unsupported MEMORY_BACKEND=file development escape hatch — same split as
 * games (server/services/games/store.js). Federation is backend-neutral and
 * operates through the sanitized record lifecycle above this facade.
 */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import { createPgFileFacade, resolvePgBackend } from '../../lib/pgFileFacade.js';

const TYPE_SCHEMA_VERSION = 1;
const ID_PATTERN = /^loom-[A-Za-z0-9-]{1,80}$/;
export const isValidLoomId = (id) => typeof id === 'string' && ID_PATTERN.test(id);

function assertId(id) {
  if (!isValidLoomId(id)) {
    throw new Error(`fableLoom: invalid record id "${id}"`);
  }
}

const loomsDir = () => join(PATHS.data, 'fableloom');

function makeFileBackend() {
  const collection = createCollectionStore({
    dir: loomsDir(),
    type: 'fableloom',
    schemaVersion: TYPE_SCHEMA_VERSION,
    idPattern: ID_PATTERN,
  });

  return {
    name: 'file',
    readRaw: (id) => collection.loadOneRaw(id),
    listRaw: () => collection.loadAll(),
    listIds: () => collection.listIds(),
    // The file layout can't project — `deleted` lives inside each record, so
    // a live-only or tombstone-cutoff id list means reading them all (no
    // sanitizeRecord is configured on this collection, so loadAll() is
    // already raw — same as listRaw above). Mirrors the JS filter
    // pruneTombstonedLooms used to run over listLooms({includeDeleted:true})
    // directly — same conservative "unparseable deletedAt is kept" rule.
    listLiveIds: async () => {
      const records = await collection.loadAll();
      return records.filter((r) => r?.deleted !== true).map((r) => r.id);
    },
    listTombstoneIdsBefore: async (beforeMs) => {
      const records = await collection.loadAll();
      const out = [];
      for (const r of records) {
        if (!r?.deleted || typeof r.id !== 'string' || !r.id) continue;
        const t = Date.parse(r.deletedAt || '');
        if (Number.isFinite(t) && t < beforeMs) out.push(r.id);
      }
      return out;
    },
    writeRaw: (id, record) => collection.saveOneNow(id, record),
    deleteRaw: (id) => collection.deleteOneNow(id),
    verify: () => collection.verifySchemaVersion(),
  };
}

function makePgBackend(db) {
  return {
    name: 'postgres',
    readRaw: db.readRaw,
    listRaw: db.listRaw,
    listIds: db.listIds,
    listLiveIds: db.listLiveIds,
    listTombstoneIdsBefore: db.listTombstoneIdsBefore,
    writeRaw: db.writeRaw,
    deleteRaw: db.deleteRaw,
    verify: async () => ({
      ok: true,
      type: 'fableloom',
      onDisk: null,
      expected: null,
      message: 'collection "fableloom" @ postgres',
    }),
  };
}

const facade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: 'FableLoom requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
    loadDb: () => import('./db.js'),
    makePg: makePgBackend,
  }),
});

const queueRecordWrite = createRecordWriteQueue(assertId);

export const readRaw = async (id) => {
  assertId(id);
  return (await facade.getBackend()).readRaw(id);
};

export const listRaw = async () => (await facade.getBackend()).listRaw();

/** Every loom id (live AND tombstones) — used by tombstoneGc's ALL_ID_LISTERS. */
export const listIds = async () => (await facade.getBackend()).listIds();

/** Live loom ids only — used by tombstoneGc's LIVE_ID_LISTERS. */
export const listLiveIds = async () => (await facade.getBackend()).listLiveIds();

/** Tombstoned loom ids older than `beforeMs` — the GC candidate scan. */
export const listTombstoneIdsBefore = async (beforeMs) => (await facade.getBackend()).listTombstoneIdsBefore(beforeMs);

export const writeRaw = async (id, record) => {
  assertId(id);
  return (await facade.getBackend()).writeRaw(id, record);
};

export const deleteRaw = async (id) => {
  assertId(id);
  return (await facade.getBackend()).deleteRaw(id);
};

export const queueLoomWrite = (id, fn) => queueRecordWrite(id, fn);

export const verifySchemaVersion = async () => (await facade.getBackend()).verify();

export function _resetFableLoomBackend() {
  facade.reset();
}
