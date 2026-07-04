/**
 * Music tracks — file-backed store (escape-hatch / test backend).
 *
 * Persists to data/tracks.json (array, atomicWrite). PostgreSQL (db.js) is the
 * default; this backend is reachable only via MEMORY_BACKEND=file or
 * NODE_ENV=test. Mirrors `services/albums/file.js`; all mutation semantics live
 * in logic.js so the two backends can't drift.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { sanitizeTrack, buildTrackRecord, applyTrackPatch, mergeTrackRecord } from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
  withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';

const TRACKS_FILE = join(PATHS.data, 'tracks.json');

async function loadAll() {
  const raw = await readJSONFile(TRACKS_FILE, []);
  return (Array.isArray(raw) ? raw : []).map(sanitizeTrack).filter(Boolean);
}

async function saveAll(tracks) {
  await ensureDir(PATHS.data);
  await atomicWrite(TRACKS_FILE, tracks);
}

// Tracks list in creation order (the album's trackIds drive display order).
const byCreated = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '');

export async function listTracks({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((t) => !t.deleted)).sort(byCreated);
}

export async function getTrack(id, { includeDeleted = false } = {}) {
  const all = await loadAll();
  const found = all.find((t) => t.id === id);
  if (!found) return null;
  return includeDeleted || !found.deleted ? found : null;
}

/** Live track ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listTrackIds({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return (includeDeleted ? all : all.filter((t) => !t.deleted)).map((t) => t.id);
}

export async function createTrack(input) {
  const track = buildTrackRecord(input, { id: `track-${randomUUID()}`, now: new Date().toISOString() });
  if (!track) throw new ServerError('Invalid track payload', { status: 400, code: 'VALIDATION' });
  const all = await loadAll();
  all.push(track);
  await saveAll(all);
  console.log(`🎵 Created track: ${track.id} (${track.title})`);
  return track;
}

export async function updateTrack(id, patch) {
  const all = await loadAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  const next = applyTrackPatch(all[idx], patch);
  if (!next) throw new ServerError('Invalid track payload', { status: 400, code: 'VALIDATION' });
  all[idx] = next;
  await saveAll(all);
  return next;
}

export async function deleteTrack(id) {
  const all = await loadAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  const now = new Date().toISOString();
  all[idx] = { ...all[idx], deleted: true, deletedAt: now, updatedAt: now };
  await saveAll(all);
  return { id };
}

/** File-backend mirror of db.js `mergeTracksFromSync` (LWW-per-id, tombstone-aware). */
export async function mergeTracksFromSync(remoteTracks, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteTracks)) return { applied: false, count: 0 };
  const all = await loadAll();
  const byId = new Map(all.map((t) => [t.id, t]));
  let changed = 0;
  for (const remote of remoteTracks) {
    const local = byId.get(remote?.id) || null;
    const { next, inserted, remoteWins, changed: didChange } = mergeTrackRecord(local, remote);
    if (!next) continue;
    if (inserted) {
      byId.set(next.id, next);
      await setSyncBaseHash('track', next.id, contentHashForRecord('track', next));
      changed += 1;
      continue;
    }
    if (!remoteWins || !didChange) continue;
    await maybeJournalBeforeOverwrite({ kind: 'track', id: next.id, local, remote: next, source });
    byId.set(next.id, next);
    await setSyncBaseHash('track', next.id, contentHashForRecord('track', next));
    changed += 1;
  }
  if (changed > 0) await saveAll([...byId.values()]);
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/** Hard-remove tombstoned tracks whose deletedAt is older than the cutoff. */
export async function pruneTombstonedTracks(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const all = await loadAll();
  const survivors = [];
  const pruned = [];
  for (const t of all) {
    const ms = t.deleted ? Date.parse(t.deletedAt || '') : NaN;
    if (t.deleted && Number.isFinite(ms) && ms < olderThanMs) pruned.push(t.id);
    else survivors.push(t);
  }
  if (pruned.length === 0) return { pruned: 0 };
  await saveAll(survivors);
  // Coalesce the per-track base-hash evictions into ONE disk write.
  await withBaseHashFlushBatch(async () => {
    for (const id of pruned) await deleteSyncBaseHash('track', id);
  });
  return { pruned: pruned.length };
}
