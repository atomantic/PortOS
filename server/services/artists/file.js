/**
 * Music artists — file-backed store (escape-hatch / test backend).
 *
 * Persists to data/artists.json (array, atomicWrite). PostgreSQL (db.js) is the
 * default; this backend is reachable only via MEMORY_BACKEND=file or
 * NODE_ENV=test. Mirrors `services/authors/file.js`; all mutation semantics live
 * in logic.js so this backend and the PG backend can't drift.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { sanitizeArtist, buildArtistRecord, applyArtistPatch, mergeArtistRecord } from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';

const ARTISTS_FILE = join(PATHS.data, 'artists.json');

async function loadAll() {
  const raw = await readJSONFile(ARTISTS_FILE, []);
  return (Array.isArray(raw) ? raw : []).map(sanitizeArtist).filter(Boolean);
}

async function saveAll(artists) {
  await ensureDir(PATHS.data);
  await atomicWrite(ARTISTS_FILE, artists);
}

const byName = (a, b) => (a.name || '').localeCompare(b.name || '');

export async function listArtists({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((a) => !a.deleted)).sort(byName);
}

export async function getArtist(id, { includeDeleted = false } = {}) {
  const all = await loadAll();
  const found = all.find((a) => a.id === id);
  if (!found) return null;
  return includeDeleted || !found.deleted ? found : null;
}

/** Live artist ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listArtistIds({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((a) => !a.deleted)).map((a) => a.id);
}

export async function createArtist(input) {
  const artist = buildArtistRecord(input, { id: `artist-${randomUUID()}`, now: new Date().toISOString() });
  if (!artist) throw new ServerError('Invalid artist payload', { status: 400, code: 'VALIDATION' });
  const all = await loadAll();
  all.push(artist);
  await saveAll(all);
  console.log(`🎤 Created music artist: ${artist.id} (${artist.name})`);
  return artist;
}

export async function updateArtist(id, patch) {
  const all = await loadAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Artist not found', { status: 404, code: 'NOT_FOUND' });
  const next = applyArtistPatch(all[idx], patch);
  if (!next) throw new ServerError('Invalid artist payload', { status: 400, code: 'VALIDATION' });
  all[idx] = next;
  await saveAll(all);
  return next;
}

export async function deleteArtist(id) {
  const all = await loadAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Artist not found', { status: 404, code: 'NOT_FOUND' });
  const now = new Date().toISOString();
  all[idx] = { ...all[idx], deleted: true, deletedAt: now, updatedAt: now };
  await saveAll(all);
  return { id };
}

/** File-backend mirror of db.js `mergeArtistsFromSync` (LWW-per-id, tombstone-aware). */
export async function mergeArtistsFromSync(remoteArtists, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteArtists)) return { applied: false, count: 0 };
  const all = await loadAll();
  const byId = new Map(all.map((a) => [a.id, a]));
  let changed = 0;
  for (const remote of remoteArtists) {
    const local = byId.get(remote?.id) || null;
    const { next, inserted, remoteWins, changed: didChange } = mergeArtistRecord(local, remote);
    if (!next) continue;
    if (inserted) {
      byId.set(next.id, next);
      await setSyncBaseHash('artist', next.id, contentHashForRecord('artist', next));
      changed += 1;
      continue;
    }
    if (!remoteWins || !didChange) continue;
    await maybeJournalBeforeOverwrite({ kind: 'artist', id: next.id, local, remote: next, source });
    byId.set(next.id, next);
    await setSyncBaseHash('artist', next.id, contentHashForRecord('artist', next));
    changed += 1;
  }
  if (changed > 0) await saveAll([...byId.values()]);
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/** Hard-remove tombstoned artists whose deletedAt is older than the cutoff. */
export async function pruneTombstonedArtists(olderThanMs) {
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
  for (const id of pruned) await deleteSyncBaseHash('artist', id);
  return { pruned: pruned.length };
}
