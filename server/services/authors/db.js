/**
 * Author personas — PostgreSQL leaf I/O.
 *
 * One row per author in `authors`: the full sanitized record in `data` JSONB,
 * with `name` + the LWW/tombstone trio (updated_at/deleted/deleted_at) mirrored
 * into columns for the queries the service runs (live list, delete-guard).
 * Reads return `data` verbatim — the columns are a queryable mirror, never read
 * back. Mutations run inside withTransaction + SELECT … FOR UPDATE so a
 * read-modify-write spanning two pool round-trips can't lose an update.
 *
 * All mutation semantics live in logic.js (shared with file.js) so the two
 * backends can't drift; this module only does row I/O + locking.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import { buildAuthorRecord, applyAuthorPatch, mergeAuthorRecord } from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
  withBaseHashFlushBatch,
} from '../../lib/conflictJournal.js';

function rowToAuthor(row) {
  return row ? row.data : null;
}

async function persist(exec, author) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(author.createdAt, now);
  await exec(
    `INSERT INTO authors (id, name, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      author.id,
      typeof author.name === 'string' ? author.name : '',
      JSON.stringify(author),
      createdAt,
      mirrorTimestamp(author.updatedAt, createdAt),
      author.deleted === true,
      mirrorTimestamp(author.deletedAt, null),
    ],
  );
  return author;
}

export async function listAuthors({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT data FROM authors ORDER BY name ASC`)
    : await query(`SELECT data FROM authors WHERE deleted = FALSE ORDER BY name ASC`);
  return rows.map(rowToAuthor);
}

export async function getAuthor(id, { includeDeleted = false } = {}) {
  const { rows } = await query(`SELECT data FROM authors WHERE id = $1`, [id]);
  const author = rowToAuthor(rows[0]);
  if (!author) return null;
  return includeDeleted || !author.deleted ? author : null;
}

/** Live author ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listAuthorIds({ includeDeleted = false } = {}) {
  const { rows } = includeDeleted
    ? await query(`SELECT id FROM authors`)
    : await query(`SELECT id FROM authors WHERE deleted = FALSE`);
  return rows.map((r) => r.id);
}

export async function createAuthor(input) {
  const author = buildAuthorRecord(input, { id: `auth-${randomUUID()}`, now: new Date().toISOString() });
  if (!author) throw new ServerError('Invalid author payload', { status: 400, code: 'VALIDATION' });
  await persist(query, author);
  console.log(`✍️ Created author persona: ${author.id} (${author.name})`);
  return author;
}

export async function updateAuthor(id, patch) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM authors WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToAuthor(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Author not found', { status: 404, code: 'NOT_FOUND' });
    const next = applyAuthorPatch(current, patch);
    if (!next) throw new ServerError('Invalid author payload', { status: 400, code: 'VALIDATION' });
    await persist(client.query.bind(client), next);
    return next;
  });
}

export async function deleteAuthor(id) {
  return withTransaction(async (client) => {
    const sel = await client.query(`SELECT data FROM authors WHERE id = $1 FOR UPDATE`, [id]);
    const current = rowToAuthor(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Author not found', { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const next = { ...current, deleted: true, deletedAt: now, updatedAt: now };
    await persist(client.query.bind(client), next);
    return { id };
  });
}

/**
 * Merge an incoming batch of author records from a peer (per-record push). Each
 * record's read-modify-write runs inside `withTransaction` + `SELECT … FOR
 * UPDATE` so a concurrent local edit can't lose to (or clobber) the merge. LWW
 * on `updatedAt` (tombstone-aware) via the shared `mergeAuthorRecord` decision —
 * identical to the file backend so the two can't drift. Seeds/advances the
 * conflict-journal base hash like `mergeMediaCollectionsFromSync`, and journals
 * the about-to-be-overwritten local version when remote wins (best-effort, never
 * throws into the merge). Returns `{ applied, count }`.
 */
export async function mergeAuthorsFromSync(remoteAuthors, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteAuthors)) return { applied: false, count: 0 };
  let changed = 0;
  for (const remote of remoteAuthors) {
    const applied = await withTransaction(async (client) => {
      const sel = await client.query(`SELECT data FROM authors WHERE id = $1 FOR UPDATE`, [remote?.id]);
      const local = rowToAuthor(sel.rows[0]);
      const { next, inserted, remoteWins, changed: didChange } = mergeAuthorRecord(local, remote);
      if (!next) return false; // malformed remote → dropped
      if (inserted) {
        await persist(client.query.bind(client), next);
        // No local counterpart to lose — seed the base hash so a FUTURE
        // divergence on this author is detected.
        await setSyncBaseHash('author', next.id, contentHashForRecord('author', next));
        return true;
      }
      // local wins, OR remote won but is byte-identical to local (no divergence
      // to journal and nothing to advance). Unlike mergeMediaCollectionsFromSync
      // — which journals on every remoteWins because its item-union can still
      // produce a no-op net write after a scalar overwrite — an author record is
      // LWW-overwritten whole, so `remoteWins && !didChange` genuinely means the
      // two sides already agree.
      if (!remoteWins || !didChange) return false;
      // Remote scalars are about to overwrite local's — journal the lost local
      // version when BOTH sides diverged from the last synced base (best-effort).
      await maybeJournalBeforeOverwrite({ kind: 'author', id: next.id, local, remote: next, source });
      await persist(client.query.bind(client), next);
      await setSyncBaseHash('author', next.id, contentHashForRecord('author', next));
      return true;
    });
    if (applied) changed += 1;
  }
  // Persist the batched base-hash updates accumulated above in one write.
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/**
 * Hard-remove tombstoned authors whose deletedAt is older than the cutoff.
 * Called by tombstoneGc once every subscribed peer has acked the deletion.
 * Evicts each pruned author's conflict-journal base hash so the side store
 * doesn't grow dead keys (mirrors pruneTombstonedCollections).
 */
export async function pruneTombstonedAuthors(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM authors
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  // Coalesce the per-author base-hash evictions into ONE disk write — each
  // `deleteSyncBaseHash` otherwise flushes `sync_base_hashes.json` per row.
  await withBaseHashFlushBatch(async () => {
    for (const r of rows) await deleteSyncBaseHash('author', r.id);
  });
  return { pruned: rows.length };
}
