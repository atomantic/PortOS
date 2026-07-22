/**
 * Sprites — file-backed record store (escape-hatch / test backend).
 *
 * Persists to data/sprite-records.json (array, atomicWrite). Reachable only
 * via MEMORY_BACKEND=file or NODE_ENV=test — PostgreSQL (recordsDB.js) is the
 * default. Mutation semantics live in recordsLogic.js so this backend and the
 * PG backend can't drift. Mirrors musicVideo/projectsFile.js.
 */

import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { buildSpriteRecord, applySpriteRecordPatch, mergeImportedRecord } from './recordsLogic.js';

const RECORDS_FILE = join(PATHS.data, 'sprite-records.json');

async function loadAll() {
  const raw = await readJSONFile(RECORDS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

async function saveAll(records) {
  await ensureDir(PATHS.data);
  await atomicWrite(RECORDS_FILE, records);
}

export async function listRecords({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return includeDeleted ? all : all.filter((r) => !r.deleted);
}

export async function getRecord(id, { includeDeleted = false } = {}) {
  const all = await loadAll();
  const found = all.find((r) => r.id === id);
  if (!found) return null;
  return includeDeleted || !found.deleted ? found : null;
}

export async function createRecord(input, id) {
  const now = new Date().toISOString();
  const all = await loadAll();
  if (all.some((r) => r.id === id && !r.deleted)) {
    throw new ServerError(`Sprite record already exists: ${id}`, { status: 409, code: 'ALREADY_EXISTS' });
  }
  const record = buildSpriteRecord(input, { id, now });
  all.push(record);
  await saveAll(all);
  console.log(`🎞️ Created sprite record: ${id} (${record.kind})`);
  return record;
}

export async function updateRecord(id, patch) {
  const all = await loadAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Sprite record not found', { status: 404, code: 'NOT_FOUND' });
  all[idx] = applySpriteRecordPatch(all[idx], patch);
  await saveAll(all);
  return all[idx];
}

export async function deleteRecord(id) {
  const all = await loadAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Sprite record not found', { status: 404, code: 'NOT_FOUND' });
  const now = new Date().toISOString();
  all[idx] = { ...all[idx], deleted: true, deletedAt: now, updatedAt: now };
  await saveAll(all);
  return { ok: true };
}

/** Importer upsert — create or refresh a record from a source-tree import. */
export async function upsertImportedRecord(id, input) {
  const now = new Date().toISOString();
  const imported = buildSpriteRecord(input, { id, now });
  const all = await loadAll();
  const idx = all.findIndex((r) => r.id === id);
  const next = mergeImportedRecord(idx >= 0 ? all[idx] : null, imported, now);
  if (idx >= 0) all[idx] = next; else all.push(next);
  await saveAll(all);
  return next;
}
