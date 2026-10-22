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
import { createPgFileFacade, resolvePgBackend } from '../../lib/pgFileFacade.js';
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
  };
}

const facade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: 'Storyboards require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
    loadDb: () => import('./db.js'),
    makePg: (db) => ({ name: 'postgres', readRaw: db.readRaw, listRaw: db.listRaw, writeRaw: db.writeRaw }),
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

export const queueStoryboardWrite = (id, fn) => queueRecordWrite(id, fn);

export function _resetStoryboardBackend() {
  facade.reset();
}
