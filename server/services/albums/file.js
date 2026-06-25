/**
 * Music albums — file-backed store (escape-hatch / test backend).
 *
 * Persists to data/albums.json (array, atomicWrite). PostgreSQL (db.js) is the
 * default; this backend is reachable only via MEMORY_BACKEND=file or
 * NODE_ENV=test. Mirrors `services/artists/file.js`; all mutation semantics live
 * in logic.js so the two backends can't drift.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { sanitizeAlbum, buildAlbumRecord, applyAlbumPatch, mergeAlbumRecord } from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';

const ALBUMS_FILE = join(PATHS.data, 'albums.json');

async function loadAll() {
  const raw = await readJSONFile(ALBUMS_FILE, []);
  return (Array.isArray(raw) ? raw : []).map(sanitizeAlbum).filter(Boolean);
}

async function saveAll(albums) {
  await ensureDir(PATHS.data);
  await atomicWrite(ALBUMS_FILE, albums);
}

const byTitle = (a, b) => (a.title || '').localeCompare(b.title || '');

export async function listAlbums({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((a) => !a.deleted)).sort(byTitle);
}

export async function getAlbum(id, { includeDeleted = false } = {}) {
  const all = await loadAll();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  return includeDeleted || !found.deleted ? found : null;
}

/** Live album ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listAlbumIds({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((a) => !a.deleted)).map((a) => a.id);
}

export async function createAlbum(input) {
  const album = buildAlbumRecord(input, { id: `album-${randomUUID()}`, now: new Date().toISOString() });
  if (!album) throw new ServerError('Invalid album payload', { status: 400, code: 'VALIDATION' });
  const all = await loadAll();
  all.push(album);
  await saveAll(all);
  console.log(`💿 Created album: ${album.id} (${album.title})`);
  return album;
}

export async function updateAlbum(id, patch) {
  const all = await loadAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Album not found', { status: 404, code: 'NOT_FOUND' });
  const next = applyAlbumPatch(all[idx], patch);
  if (!next) throw new ServerError('Invalid album payload', { status: 400, code: 'VALIDATION' });
  all[idx] = next;
  await saveAll(all);
  return next;
}

export async function deleteAlbum(id) {
  const all = await loadAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Album not found', { status: 404, code: 'NOT_FOUND' });
  const now = new Date().toISOString();
  all[idx] = { ...all[idx], deleted: true, deletedAt: now, updatedAt: now };
  await saveAll(all);
  return { id };
}

/** File-backend mirror of db.js `mergeAlbumsFromSync` (LWW-per-id, tombstone-aware). */
export async function mergeAlbumsFromSync(remoteAlbums, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteAlbums)) return { applied: false, count: 0 };
  const all = await loadAll();
  const byId = new Map(all.map((a) => [a.id, a]));
  let changed = 0;
  for (const remote of remoteAlbums) {
    const local = byId.get(remote?.id) || null;
    const { next, inserted, remoteWins, changed: didChange } = mergeAlbumRecord(local, remote);
    if (!next) continue;
    if (inserted) {
      byId.set(next.id, next);
      await setSyncBaseHash('album', next.id, contentHashForRecord('album', next));
      changed += 1;
      continue;
    }
    if (!remoteWins || !didChange) continue;
    await maybeJournalBeforeOverwrite({ kind: 'album', id: next.id, local, remote: next, source });
    byId.set(next.id, next);
    await setSyncBaseHash('album', next.id, contentHashForRecord('album', next));
    changed += 1;
  }
  if (changed > 0) await saveAll([...byId.values()]);
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/** Hard-remove tombstoned albums whose deletedAt is older than the cutoff. */
export async function pruneTombstonedAlbums(olderThanMs) {
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
  for (const id of pruned) await deleteSyncBaseHash('album', id);
  return { pruned: pruned.length };
}
