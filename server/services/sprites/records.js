/**
 * Sprites — record store backend dispatcher (issue #2895, phase 1).
 *
 * Mirrors the Music Video dispatcher (services/musicVideo/projects.js): a thin
 * layer that picks the backend so every import site + test mock targets one
 * module.
 *
 * Backend selection (same posture as the memory backend):
 *   - PostgreSQL (recordsDB.js) for normal installs.
 *   - File (recordsFile.js) only via MEMORY_BACKEND=file (escape hatch) or
 *     NODE_ENV=test — both UNSUPPORTED for production.
 *
 * No federation wiring: sprite records are machine-local in phase 1 (per
 * #2895's scope); the tombstone trio on the record keeps peer-sync additive.
 */

import { isTestRunner } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createRecordStoreBackendSelector } from '../../lib/pgFileFacade.js';
import { listSpriteAssets } from './paths.js';
import { deriveSpriteId, isValidSpriteId } from './recordsLogic.js';

// Shared dispatcher (#2899). isTestRunner (NODE_ENV==='test' OR VITEST) is the
// repo's supported test detection — a wrapper that drops NODE_ENV must still
// select the file backend instead of hitting the real DB's test gate.
const { selectBackend } = createRecordStoreBackendSelector({
  label: 'Sprites',
  loadFileBackend: () => import('./recordsFile.js'),
  loadDbBackend: () => import('./recordsDB.js'),
  isTestMode: isTestRunner,
});

export async function listRecords(options = {}) {
  return (await selectBackend()).listRecords(options);
}

export async function getRecord(id, options = {}) {
  return (await selectBackend()).getRecord(id, options);
}

/**
 * Detail view: the record plus its on-disk asset listing, fetched in
 * parallel. Returns null for an unknown/tombstoned record.
 */
export async function getRecordWithAssets(id) {
  const [record, assets] = await Promise.all([getRecord(id), listSpriteAssets(id)]);
  return record ? { record, assets } : null;
}

export async function createRecord(input, id) {
  return (await selectBackend()).createRecord(input, id);
}

/**
 * Create a sprite record (the reference-workflow entry point for characters) —
 * derives the id from the name when not supplied. `kind` defaults to
 * `character`; the UI also creates `place`/`object` records here (#2932).
 * `props` families stay import-only. Only character records unlock the
 * reference → walk → publish workflows (gated client-side on kind).
 */
export async function createCharacter({ id, name, spec = null, kind = 'character' }) {
  const recordId = id || deriveSpriteId(name);
  if (!isValidSpriteId(recordId)) {
    throw new ServerError(`Cannot derive a valid sprite id from "${name}" — pass an explicit id`, { status: 400, code: 'INVALID_SPRITE_ID' });
  }
  // Tombstoned ids stay taken: the old data/sprites/<id> tree (possibly a
  // LOCKED reference set) is still on disk, so a re-created record would
  // silently inherit a frozen identity it can never regenerate.
  const existing = await getRecord(recordId, { includeDeleted: true });
  if (existing?.deleted) {
    throw new ServerError(`A deleted record still holds the id "${recordId}" (its assets remain on disk) — pass a different id`, { status: 409, code: 'ID_TOMBSTONED' });
  }
  // buildSpriteRecord validates kind against SPRITE_RECORD_KINDS and falls
  // back to 'character' for anything unexpected — the Zod schema enum-gates it
  // before this point, so an out-of-set value can't reach here from the route.
  return createRecord({ kind, name, spec }, recordId);
}

export async function updateRecord(id, patch) {
  return (await selectBackend()).updateRecord(id, patch);
}

export async function deleteRecord(id) {
  return (await selectBackend()).deleteRecord(id);
}

export async function upsertImportedRecord(id, input) {
  return (await selectBackend()).upsertImportedRecord(id, input);
}
