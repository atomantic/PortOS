/**
 * Game records — PostgreSQL/file backend facade.
 *
 * Games are db-primary in normal installs. The collectionStore backend keeps
 * the domain runnable in tests and under the unsupported MEMORY_BACKEND=file
 * development escape hatch. Compiled manifest assets live beside the record
 * directory under data/games/<id>/manifests on both backends.
 */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import { createPgFileFacade, resolvePgBackend } from '../../lib/pgFileFacade.js';

const TYPE_SCHEMA_VERSION = 1;
const ID_PATTERN = /^game-[A-Za-z0-9-]{1,80}$/;
export const isValidGameId = (id) => typeof id === 'string' && ID_PATTERN.test(id);

function assertId(id) {
  if (!isValidGameId(id)) {
    throw new Error(`games: invalid record id "${id}"`);
  }
}

const gamesDir = () => join(PATHS.data, 'games');

function makeFileBackend() {
  const collection = createCollectionStore({
    dir: gamesDir(),
    type: 'games',
    schemaVersion: TYPE_SCHEMA_VERSION,
    idPattern: ID_PATTERN,
  });

  return {
    name: 'file',
    readRaw: (id) => collection.loadOneRaw(id),
    listRaw: () => collection.loadAll(),
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
    writeRaw: db.writeRaw,
    deleteRaw: db.deleteRaw,
    verify: async () => ({
      ok: true,
      type: 'games',
      onDisk: null,
      expected: null,
      message: 'collection "games" @ postgres (#3177)',
    }),
  };
}

const facade = createPgFileFacade({
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: 'Games require PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)',
    loadDb: () => import('./db.js'),
    makePg: makePgBackend,
  }),
});

const queueRecordWrite = createRecordWriteQueue(assertId);

export const gameRecordDir = (id) => {
  assertId(id);
  return join(gamesDir(), id);
};

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

export const queueGameWrite = (id, fn) => queueRecordWrite(id, fn);

export const verifySchemaVersion = async () => (await facade.getBackend()).verify();

export function _resetGamesBackend() {
  facade.reset();
}
