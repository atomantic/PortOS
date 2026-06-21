/**
 * Music albums — PostgreSQL leaf I/O.
 *
 * One row per album in `albums`: the full sanitized record in `data` JSONB, with
 * `title` + the LWW/tombstone trio mirrored into columns. Reads return `data`
 * verbatim. Mutations run inside withTransaction + SELECT … FOR UPDATE. Mirrors
 * `services/artists/db.js`; all mutation semantics live in logic.js.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import { buildAlbumRecord, applyAlbumPatch, mergeAlbumRecord } from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';

function rowToAlbum(row) {
  return row ? row.data : null;
}

async function persist(exec, album) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(album.createdAt, now);
  await exec(
    `INSERT INTO albums (id, title, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      album.id,
      typeof album.title === 'string' ? album.title : '',
      JSON.stringify(album),
      createdAt,
      mirrorTimestamp(album.updatedAt, createdAt),
      album.deleted === true,
      mirrorTimestamp(album.deletedAt, null),
    ],
  );
  return album;
}

export async function listAlbums({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT data FROM albums ORDER BY title ASC`)
    : await query(`SELECT data FROM albums WHERE deleted = FALSE ORDER BY title ASC`);
  return rows.map(rowToAlbum);
}

export async function getAlbum(id, { includeDeleted = false } = {}) {
  const { rows } = await query(`SELECT data FROM albums WHERE id = $1`, [id]);
  const album = rowToAlbum(rows[0]);
  if (!album) return null;
  return includeDeleted || !album.deleted ? album : null;
}

/** Live album ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listAlbumIds({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT id FROM albums`)
    : await query(`SELECT id FROM albums WHERE deleted = FALSE`);
  return rows.map((r) => r.id);
}

export async function createAlbum(input) {
  const album = buildAlbumRecord(input, { id: `album-${randomUUID()}`, now: new Date().toISOString() });
  if (!album) throw new ServerError('Invalid album payload', { status: 400, code: 'VALIDATION' });
  await persist(query, album);
  console.log(`💿 Created album: ${album.id} (${album.title})`);
  return album;
}

export async function updateAlbum(id, patch) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM albums WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToAlbum(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Album not found', { status: 404, code: 'NOT_FOUND' });
    const next = applyAlbumPatch(current, patch);
    if (!next) throw new ServerError('Invalid album payload', { status: 400, code: 'VALIDATION' });
    await persist(client.query.bind(client), next);
    return next;
  });
}

export async function deleteAlbum(id) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM albums WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToAlbum(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Album not found', { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const next = { ...current, deleted: true, deletedAt: now, updatedAt: now };
    await persist(client.query.bind(client), next);
    return { id };
  });
}

/**
 * Merge an incoming batch of album records from a peer (per-record push). LWW on
 * `updatedAt` (tombstone-aware) via the shared `mergeAlbumRecord` decision.
 * Federation-ready, but the album kind is not yet registered in peerSync — see
 * issue #1502. Returns `{ applied, count }`.
 */
export async function mergeAlbumsFromSync(remoteAlbums, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteAlbums)) return { applied: false, count: 0 };
  let changed = 0;
  for (const remote of remoteAlbums) {
    const applied = await withTransaction(async (client) => {
      const sel = await client.query(`SELECT data FROM albums WHERE id = $1 FOR UPDATE`, [remote?.id]);
      const local = rowToAlbum(sel.rows[0]);
      const { next, inserted, remoteWins, changed: didChange } = mergeAlbumRecord(local, remote);
      if (!next) return false;
      if (inserted) {
        await persist(client.query.bind(client), next);
        await setSyncBaseHash('album', next.id, contentHashForRecord('album', next));
        return true;
      }
      if (!remoteWins || !didChange) return false;
      await maybeJournalBeforeOverwrite({ kind: 'album', id: next.id, local, remote: next, source });
      await persist(client.query.bind(client), next);
      await setSyncBaseHash('album', next.id, contentHashForRecord('album', next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/** Hard-remove tombstoned albums whose deletedAt is older than the cutoff. */
export async function pruneTombstonedAlbums(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM albums
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  for (const r of rows) await deleteSyncBaseHash('album', r.id);
  return { pruned: rows.length };
}
