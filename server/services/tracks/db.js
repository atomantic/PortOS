/**
 * Music tracks — PostgreSQL leaf I/O.
 *
 * One row per track in `tracks`: the full sanitized record in `data` JSONB, with
 * `title` + the LWW/tombstone trio mirrored into columns. Reads return `data`
 * verbatim. Mutations run inside withTransaction + SELECT … FOR UPDATE. Mirrors
 * `services/albums/db.js`; all mutation semantics live in logic.js.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import { sanitizeTrack, buildTrackRecord, applyTrackPatch, mergeTrackRecord } from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
  withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';

// Re-sanitize the stored JSONB on read (mirrors the file backend's loadAll →
// sanitizeTrack). The record was already sanitized on write, so for an in-shape
// row this is a no-op; the reason to do it is forward-compat BACKFILL — an
// additive field like `renders[]` is synthesized for legacy rows the next time
// they're read (and persisted whole on the next write), without a DB data
// migration (the scripts/migrations runner executes before the pool is up).
function rowToTrack(row) {
  return row ? sanitizeTrack(row.data) : null;
}

async function persist(exec, track) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(track.createdAt, now);
  await exec(
    `INSERT INTO tracks (id, title, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      track.id,
      typeof track.title === 'string' ? track.title : '',
      JSON.stringify(track),
      createdAt,
      mirrorTimestamp(track.updatedAt, createdAt),
      track.deleted === true,
      mirrorTimestamp(track.deletedAt, null),
    ],
  );
  return track;
}

export async function listTracks({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT data FROM tracks ORDER BY created_at ASC`)
    : await query(`SELECT data FROM tracks WHERE deleted = FALSE ORDER BY created_at ASC`);
  return rows.map(rowToTrack);
}

export async function getTrack(id, { includeDeleted = false } = {}) {
  const { rows } = await query(`SELECT data FROM tracks WHERE id = $1`, [id]);
  const track = rowToTrack(rows[0]);
  if (!track) return null;
  return includeDeleted || !track.deleted ? track : null;
}

/** Live track ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listTrackIds({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT id FROM tracks`)
    : await query(`SELECT id FROM tracks WHERE deleted = FALSE`);
  return rows.map((r) => r.id);
}

export async function createTrack(input) {
  const track = buildTrackRecord(input, { id: `track-${randomUUID()}`, now: new Date().toISOString() });
  if (!track) throw new ServerError('Invalid track payload', { status: 400, code: 'VALIDATION' });
  await persist(query, track);
  console.log(`🎵 Created track: ${track.id} (${track.title})`);
  return track;
}

export async function updateTrack(id, patch) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM tracks WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToTrack(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
    const next = applyTrackPatch(current, patch);
    if (!next) throw new ServerError('Invalid track payload', { status: 400, code: 'VALIDATION' });
    await persist(client.query.bind(client), next);
    return next;
  });
}

export async function deleteTrack(id) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM tracks WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToTrack(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const next = { ...current, deleted: true, deletedAt: now, updatedAt: now };
    await persist(client.query.bind(client), next);
    return { id };
  });
}

/**
 * Merge an incoming batch of track records from a peer (per-record push). LWW on
 * `updatedAt` (tombstone-aware) via the shared `mergeTrackRecord` decision.
 * Peer-sync merge entry point. Returns `{ applied, count }`.
 */
export async function mergeTracksFromSync(remoteTracks, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteTracks)) return { applied: false, count: 0 };
  let changed = 0;
  for (const remote of remoteTracks) {
    const applied = await withTransaction(async (client) => {
      const sel = await client.query(`SELECT data FROM tracks WHERE id = $1 FOR UPDATE`, [remote?.id]);
      const local = rowToTrack(sel.rows[0]);
      const { next, inserted, remoteWins, changed: didChange } = mergeTrackRecord(local, remote);
      if (!next) return false;
      if (inserted) {
        await persist(client.query.bind(client), next);
        await setSyncBaseHash('track', next.id, contentHashForRecord('track', next));
        return true;
      }
      if (!remoteWins || !didChange) return false;
      await maybeJournalBeforeOverwrite({ kind: 'track', id: next.id, local, remote: next, source });
      await persist(client.query.bind(client), next);
      await setSyncBaseHash('track', next.id, contentHashForRecord('track', next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/** Hard-remove tombstoned tracks whose deletedAt is older than the cutoff. */
export async function pruneTombstonedTracks(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM tracks
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  // Coalesce the per-track base-hash evictions into ONE disk write.
  await withBaseHashFlushBatch(async () => {
    for (const r of rows) await deleteSyncBaseHash('track', r.id);
  });
  return { pruned: rows.length };
}
