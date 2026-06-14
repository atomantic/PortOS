/**
 * Author personas — file-backed store (escape-hatch / test backend).
 *
 * Persists to data/authors.json (array, atomicWrite). PostgreSQL (db.js) is the
 * default; this backend is reachable only via the MEMORY_BACKEND=file escape
 * hatch or NODE_ENV=test — same posture as the memory backend. The dispatcher
 * in index.js picks between this and db.js.
 *
 * All mutation semantics live in logic.js so this backend and the PG backend
 * can't drift; this module only does load/find/persist.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { sanitizeAuthor, buildAuthorRecord, applyAuthorPatch } from './logic.js';

const AUTHORS_FILE = join(PATHS.data, 'authors.json');

async function loadAll() {
  const raw = await readJSONFile(AUTHORS_FILE, []);
  return (Array.isArray(raw) ? raw : []).map(sanitizeAuthor).filter(Boolean);
}

async function saveAll(authors) {
  await ensureDir(PATHS.data);
  await atomicWrite(AUTHORS_FILE, authors);
}

const byName = (a, b) => (a.name || '').localeCompare(b.name || '');

export async function listAuthors({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((a) => !a.deleted)).sort(byName);
}

export async function getAuthor(id) {
  const all = await loadAll();
  const found = all.find((a) => a.id === id);
  return found && !found.deleted ? found : null;
}

export async function createAuthor(input) {
  const author = buildAuthorRecord(input, { id: `auth-${randomUUID()}`, now: new Date().toISOString() });
  if (!author) throw new ServerError('Invalid author payload', { status: 400, code: 'VALIDATION' });
  const all = await loadAll();
  all.push(author);
  await saveAll(all);
  console.log(`✍️ Created author persona: ${author.id} (${author.name})`);
  return author;
}

export async function updateAuthor(id, patch) {
  const all = await loadAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Author not found', { status: 404, code: 'NOT_FOUND' });
  const next = applyAuthorPatch(all[idx], patch);
  if (!next) throw new ServerError('Invalid author payload', { status: 400, code: 'VALIDATION' });
  all[idx] = next;
  await saveAll(all);
  return next;
}

export async function deleteAuthor(id) {
  const all = await loadAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Author not found', { status: 404, code: 'NOT_FOUND' });
  const now = new Date().toISOString();
  all[idx] = { ...all[idx], deleted: true, deletedAt: now, updatedAt: now };
  await saveAll(all);
  return { id };
}
