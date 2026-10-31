/**
 * Saved storyboard recipes — the Make tab's library of named node graphs.
 *
 * db-primary (`storyboard_recipes`); collectionStore keeps it runnable in
 * tests and under the unsupported MEMORY_BACKEND=file escape hatch, the same
 * split as the boards themselves (store.js). Loading a saved recipe copies its
 * graph onto a board, so editing the board never changes the saved copy.
 */

import { join } from 'path';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createCollectionStore } from '../../lib/collectionStore.js';
import { createRecordWriteQueue } from '../../lib/fileWriteQueue.js';
import { createPgFileFacade, resolvePgBackend, POSTGRES_SETUP_HINT } from '../../lib/pgFileFacade.js';
import { sanitizeSavedRecipe } from '../../lib/storyboardRecord.js';
import {
  isValidStoryboardRecipeId, newStoryboardEntityId, STORYBOARD_RECIPE_ID_PATTERN,
} from '../../lib/storyboardVocabulary.js';

const TYPE_SCHEMA_VERSION = 1;
// A library, not an archive: past this the user deletes one first.
const SAVED_RECIPE_LIMIT = 100;

function assertId(id) {
  if (!isValidStoryboardRecipeId(id)) throw new Error(`storyboard recipes: invalid record id "${id}"`);
}

function makeFileBackend() {
  const collection = createCollectionStore({
    dir: join(PATHS.data, 'storyboard-recipes'),
    type: 'storyboard-recipes',
    schemaVersion: TYPE_SCHEMA_VERSION,
    idPattern: STORYBOARD_RECIPE_ID_PATTERN,
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
    requirement: `Storyboard recipes require PostgreSQL — ${POSTGRES_SETUP_HINT}`,
    loadDb: () => import('./recipeDb.js'),
    makePg: (db) => ({ name: 'postgres', readRaw: db.readRaw, listRaw: db.listRaw, writeRaw: db.writeRaw }),
  }),
});

const queueRecordWrite = createRecordWriteQueue(assertId);
const backend = () => facade.getBackend();
const notFound = () => new ServerError('Saved recipe not found', { status: 404, code: 'NOT_FOUND' });

export async function listSavedRecipes() {
  const rows = await (await backend()).listRaw();
  return rows
    .map(sanitizeSavedRecipe)
    .filter((record) => record && !record.deleted)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function getSavedRecipe(id) {
  if (!isValidStoryboardRecipeId(id)) throw notFound();
  const record = sanitizeSavedRecipe(await (await backend()).readRaw(id));
  if (!record || record.deleted) throw notFound();
  return record;
}

export async function saveRecipe({ name, recipe }) {
  if ((await listSavedRecipes()).length >= SAVED_RECIPE_LIMIT) {
    throw new ServerError(`The library keeps at most ${SAVED_RECIPE_LIMIT} recipes; delete one first.`, { status: 409, code: 'STORYBOARD_LIMIT' });
  }
  const now = new Date().toISOString();
  const record = sanitizeSavedRecipe({ id: newStoryboardEntityId('sbr'), name, recipe, createdAt: now, updatedAt: now });
  await (await backend()).writeRaw(record.id, record);
  console.log(`🧩 Saved storyboard recipe ${record.id}`);
  return record;
}

export async function deleteSavedRecipe(id) {
  if (!isValidStoryboardRecipeId(id)) throw notFound();
  return queueRecordWrite(id, async () => {
    const current = await getSavedRecipe(id);
    const now = new Date().toISOString();
    await (await backend()).writeRaw(id, { ...current, updatedAt: now, deleted: true, deletedAt: now });
    return { id };
  });
}
