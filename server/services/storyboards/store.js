/**
 * Storyboard records — PostgreSQL/file backend facade.
 *
 * Storyboards are db-primary (`storyboards`). The collectionStore backend
 * keeps the domain runnable in tests and under the unsupported
 * MEMORY_BACKEND=file development escape hatch — the same split as FableLoom
 * (services/fableLoom/store.js).
 */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import { createPgFileFacade, resolvePgBackend, POSTGRES_SETUP_HINT } from '../../lib/pgFileFacade.js';
import { isValidStoryboardId, STORYBOARD_ID_PATTERN } from '../../lib/storyboardVocabulary.js';

const TYPE_SCHEMA_VERSION = 1;

function assertId(id) {
  if (!isValidStoryboardId(id)) throw new Error(`storyboards: invalid record id "${id}"`);
}

function makeFileBackend() {
  const collection = createCollectionStore({
    dir: join(PATHS.data, 'storyboards'),
    type: 'storyboards',
    schemaVersion: TYPE_SCHEMA_VERSION,
    idPattern: STORYBOARD_ID_PATTERN,
  });
  return {
    name: 'file',
    readRaw: (id) => collection.loadOneRaw(id),
    listRaw: () => collection.loadAll(),
    writeRaw: (id, record) => collection.saveOneNow(id, record),
    deleteRaw: (id) => collection.deleteOneNow(id),
    // `deleted` lives inside each record on the file layout, so the live and
    // tombstone id scans read them all (dev/test only; Postgres projects ids).
    listLiveIds: async () => (await collection.loadAll()).filter((r) => r && r.deleted !== true).map((r) => r.id),
    listIds: async () => (await collection.loadAll()).filter((r) => r && typeof r.id === 'string').map((r) => r.id),
    listTombstoneIdsBefore: async (beforeMs) => (await collection.loadAll())
      .filter((r) => r?.deleted && typeof r.id === 'string' && Date.parse(r.deletedAt || '') < beforeMs)
      .map((r) => r.id),
  };
}

const facade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: `Storyboards require PostgreSQL — ${POSTGRES_SETUP_HINT}`,
    loadDb: () => import('./db.js'),
    makePg: (db) => ({
      name: 'postgres',
      readRaw: db.readRaw,
      listRaw: db.listRaw,
      writeRaw: db.writeRaw,
      deleteRaw: db.deleteRaw,
      listIds: db.listIds,
      listLiveIds: db.listLiveIds,
      listTombstoneIdsBefore: db.listTombstoneIdsBefore,
    }),
  }),
});

const queueRecordWrite = createRecordWriteQueue(assertId);

export const readRaw = async (id) => {
  assertId(id);
  return (await facade.getBackend()).readRaw(id);
};

export const listRaw = async () => (await facade.getBackend()).listRaw();

export const writeRaw = async (id, record) => {
  assertId(id);
  return (await facade.getBackend()).writeRaw(id, record);
};

export const deleteRaw = async (id) => {
  assertId(id);
  return (await facade.getBackend()).deleteRaw(id);
};

/** Every board id (live AND tombstones) — the tombstone sweep's id source. */
export const listIds = async () => (await facade.getBackend()).listIds();

/** Live board ids only — id-only projection, no JSONB bodies. */
export const listLiveIds = async () => (await facade.getBackend()).listLiveIds();

/** Tombstoned board ids deleted before `beforeMs` — the GC candidate scan. */
export const listTombstoneIdsBefore = async (beforeMs) => (await facade.getBackend()).listTombstoneIdsBefore(beforeMs);

export const queueStoryboardWrite = (id, fn) => queueRecordWrite(id, fn);

export function _resetStoryboardBackend() {
  facade.reset();
}
