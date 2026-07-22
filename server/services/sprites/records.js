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

import { checkHealth, ensureSchema, isTestRunner } from '../../lib/db.js';
import { listSpriteAssets } from './paths.js';

let backend = null;

async function selectBackend() {
  if (backend) return backend;

  // isTestRunner (NODE_ENV==='test' OR VITEST) is the repo's supported test
  // detection — a wrapper that drops NODE_ENV must still select the file
  // backend instead of hitting the real DB's test gate.
  const envBackend = process.env.MEMORY_BACKEND;
  if (envBackend === 'file' || isTestRunner()) {
    backend = await import('./recordsFile.js');
    return backend;
  }

  const health = await checkHealth();
  if (!health.connected) {
    throw new Error('Sprites requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file in .env)');
  }
  await ensureSchema();
  backend = await import('./recordsDB.js');
  return backend;
}

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

export async function updateRecord(id, patch) {
  return (await selectBackend()).updateRecord(id, patch);
}

export async function deleteRecord(id) {
  return (await selectBackend()).deleteRecord(id);
}

export async function upsertImportedRecord(id, input) {
  return (await selectBackend()).upsertImportedRecord(id, input);
}
