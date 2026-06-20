/**
 * Music artists — PostgreSQL leaf I/O.
 *
 * One row per artist in `artists`: the full sanitized record in `data` JSONB,
 * with `name` + the LWW/tombstone trio mirrored into columns for the queries the
 * service runs. Reads return `data` verbatim. Mutations run inside
 * withTransaction + SELECT … FOR UPDATE. Mirrors `services/authors/db.js`; all
 * mutation semantics live in logic.js (shared with file.js) so the two backends
 * can't drift.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import { buildArtistRecord, applyArtistPatch, mergeArtistRecord } from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';

function rowToArtist(row) {
  return row ? row.data : null;
}

async function persist(exec, artist) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(artist.createdAt, now);
  await exec(
    `INSERT INTO artists (id, name, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      artist.id,
      typeof artist.name === 'string' ? artist.name : '',
      JSON.stringify(artist),
      createdAt,
      mirrorTimestamp(artist.updatedAt, createdAt),
      artist.deleted === true,
      mirrorTimestamp(artist.deletedAt, null),
    ],
  );
  return artist;
}

export async function listArtists({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT data FROM artists ORDER BY name ASC`)
    : await query(`SELECT data FROM artists WHERE deleted = FALSE ORDER BY name ASC`);
  return rows.map(rowToArtist);
}

export async function getArtist(id, { includeDeleted = false } = {}) {
  const { rows } = await query(`SELECT data FROM artists WHERE id = $1`, [id]);
  const artist = rowToArtist(rows[0]);
  if (!artist) return null;
  return includeDeleted || !artist.deleted ? artist : null;
}

/** Live artist ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listArtistIds({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT id FROM artists`)
    : await query(`SELECT id FROM artists WHERE deleted = FALSE`);
  return rows.map((r) => r.id);
}

export async function createArtist(input) {
  const artist = buildArtistRecord(input, { id: `artist-${randomUUID()}`, now: new Date().toISOString() });
  if (!artist) throw new ServerError('Invalid artist payload', { status: 400, code: 'VALIDATION' });
  await persist(query, artist);
  console.log(`🎤 Created music artist: ${artist.id} (${artist.name})`);
  return artist;
}

export async function updateArtist(id, patch) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM artists WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToArtist(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Artist not found', { status: 404, code: 'NOT_FOUND' });
    const next = applyArtistPatch(current, patch);
    if (!next) throw new ServerError('Invalid artist payload', { status: 400, code: 'VALIDATION' });
    await persist(client.query.bind(client), next);
    return next;
  });
}

export async function deleteArtist(id) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM artists WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToArtist(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Artist not found', { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const next = { ...current, deleted: true, deletedAt: now, updatedAt: now };
    await persist(client.query.bind(client), next);
    return { id };
  });
}

/**
 * Merge an incoming batch of artist records from a peer (per-record push). LWW
 * on `updatedAt` (tombstone-aware) via the shared `mergeArtistRecord` decision.
 * Federation-ready: this is wired identically to authors, but the artist kind is
 * not yet registered in peerSync — see issue #1502. Returns `{ applied, count }`.
 */
export async function mergeArtistsFromSync(remoteArtists, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteArtists)) return { applied: false, count: 0 };
  let changed = 0;
  for (const remote of remoteArtists) {
    const applied = await withTransaction(async (client) => {
      const sel = await client.query(`SELECT data FROM artists WHERE id = $1 FOR UPDATE`, [remote?.id]);
      const local = rowToArtist(sel.rows[0]);
      const { next, inserted, remoteWins, changed: didChange } = mergeArtistRecord(local, remote);
      if (!next) return false;
      if (inserted) {
        await persist(client.query.bind(client), next);
        await setSyncBaseHash('artist', next.id, contentHashForRecord('artist', next));
        return true;
      }
      if (!remoteWins || !didChange) return false;
      await maybeJournalBeforeOverwrite({ kind: 'artist', id: next.id, local, remote: next, source });
      await persist(client.query.bind(client), next);
      await setSyncBaseHash('artist', next.id, contentHashForRecord('artist', next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/** Hard-remove tombstoned artists whose deletedAt is older than the cutoff. */
export async function pruneTombstonedArtists(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM artists
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  for (const r of rows) await deleteSyncBaseHash('artist', r.id);
  return { pruned: rows.length };
}
