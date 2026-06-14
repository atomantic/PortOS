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
import { buildAuthorRecord, applyAuthorPatch } from './logic.js';

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

export async function getAuthor(id) {
  const { rows } = await query(`SELECT data FROM authors WHERE id = $1`, [id]);
  const author = rowToAuthor(rows[0]);
  return author && !author.deleted ? author : null;
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
