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
import { sanitizeAuthor, buildAuthorRecord, applyAuthorPatch, mergeAuthorRecord } from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
  withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';

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

export async function getAuthor(id, { includeDeleted = false } = {}) {
  const all = await loadAll();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  return includeDeleted || !found.deleted ? found : null;
}

/** Live author ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listAuthorIds({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((a) => !a.deleted)).map((a) => a.id);
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

/**
 * File-backend mirror of db.js `mergeAuthorsFromSync` — LWW-per-id (tombstone-
 * aware) via the shared `mergeAuthorRecord` decision so the two backends can't
 * drift. Single load → per-record merge → single save (the file is small and
 * the app is single-instance, so one read-modify-write covers the batch).
 */
export async function mergeAuthorsFromSync(remoteAuthors, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteAuthors)) return { applied: false, count: 0 };
  const all = await loadAll();
  const byId = new Map(all.map((a) => [a.id, a]));
  let changed = 0;
  for (const remote of remoteAuthors) {
    const local = byId.get(remote?.id) || null;
    const { next, inserted, remoteWins, changed: didChange } = mergeAuthorRecord(local, remote);
    if (!next) continue;
    if (inserted) {
      byId.set(next.id, next);
      await setSyncBaseHash('author', next.id, contentHashForRecord('author', next));
      changed += 1;
      continue;
    }
    // local wins, OR remote won but is byte-identical to local (already agree —
    // nothing to journal or advance). See db.js for why authors skip the
    // every-remoteWins journaling mediaCollections does.
    if (!remoteWins || !didChange) continue;
    await maybeJournalBeforeOverwrite({ kind: 'author', id: next.id, local, remote: next, source });
    byId.set(next.id, next);
    await setSyncBaseHash('author', next.id, contentHashForRecord('author', next));
    changed += 1;
  }
  if (changed > 0) await saveAll([...byId.values()]);
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/**
 * Hard-remove tombstoned authors whose deletedAt is older than the cutoff.
 * Mirrors db.js `pruneTombstonedAuthors`; evicts each pruned author's base hash.
 */
export async function pruneTombstonedAuthors(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const all = await loadAll();
  const survivors = [];
  const pruned = [];
  for (const a of all) {
    const ms = a.deleted ? Date.parse(a.deletedAt || '') : NaN;
    if (a.deleted && Number.isFinite(ms) && ms < olderThanMs) pruned.push(a.id);
    else survivors.push(a);
  }
  if (pruned.length === 0) return { pruned: 0 };
  await saveAll(survivors);
  // Coalesce the per-author base-hash evictions into ONE disk write.
  await withBaseHashFlushBatch(async () => {
    for (const id of pruned) await deleteSyncBaseHash('author', id);
  });
  return { pruned: pruned.length };
}
