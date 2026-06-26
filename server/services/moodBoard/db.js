/**
 * Mood Board — PostgreSQL-backed store (issue #911).
 *
 * One row per board in `mood_boards`: id / name / created_at / updated_at as
 * columns, the full record (name/description/items[]) in `data` JSONB. Mood
 * boards are db-primary, modeled on the creativeDirector projectsDB store. As of
 * #1564 they FEDERATE across peers via the per-record peer-sync push pipeline
 * (record kind `moodBoard`, sync category `moodBoards`), so a delete is a
 * soft-delete tombstone (deleted/deleted_at + LWW updated_at) the merge keeps an
 * out-of-date peer from resurrecting — mirroring creative_director_projects.
 *
 * Concurrency: the trust model is single-user, but a board has more than one
 * write path that can touch the SAME board (board PATCH + item add/update/remove
 * fired from different UI affordances), and a read-modify-write spanning two
 * pool round-trips would lose updates. So every mutator runs inside
 * withTransaction + `SELECT … FOR UPDATE` — the row lock serializes concurrent
 * writes to one board without blocking writes to other boards.
 *
 * All mutation semantics live in logic.js so the transforms stay unit-testable
 * without a live DB; this module only does row I/O + locking.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import { mirrorTimestamp } from '../../lib/pgTimestamp.js';
import {
  buildBoardRecord,
  applyBoardPatch,
  applyBoardRestore,
  addItem,
  updateItem,
  removeItem,
  mergeBoardRecord,
  applyPinterestLink,
  clearPinterestLinkRecord,
  appendPinterestPins,
} from './logic.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes, deleteSyncBaseHash,
} from '../../lib/conflictJournal.js';

// `data` JSONB is the whole record; name/created_at/updated_at mirror into
// columns (kept in lockstep on every write) for the live-list sort. Reads
// always return `data` verbatim so consumers see the exact stored shape.
function rowToBoard(row) {
  if (!row) return null;
  return row.data;
}

async function persist(exec, board) {
  const now = new Date().toISOString();
  const createdAt = mirrorTimestamp(board.createdAt, now);
  await exec(
    `INSERT INTO mood_boards (id, name, data, created_at, updated_at, deleted, deleted_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at,
       deleted = EXCLUDED.deleted,
       deleted_at = EXCLUDED.deleted_at`,
    [
      board.id,
      board.name,
      JSON.stringify(board),
      createdAt,
      mirrorTimestamp(board.updatedAt, createdAt),
      board.deleted === true,
      mirrorTimestamp(board.deletedAt, null),
    ],
  );
  return board;
}

export async function listBoards({ includeDeleted = false } = {}) {
  // updated_at DESC — most-recently-touched first (the board grid's default).
  const result = includeDeleted
    ? await query(`SELECT data FROM mood_boards ORDER BY updated_at DESC`)
    : await query(`SELECT data FROM mood_boards WHERE deleted = FALSE ORDER BY updated_at DESC`);
  return result.rows.map(rowToBoard);
}

export async function getBoard(id, { includeDeleted = false } = {}) {
  const result = await query(`SELECT data FROM mood_boards WHERE id = $1`, [id]);
  const board = rowToBoard(result.rows[0]);
  if (!board) return null;
  return includeDeleted || !board.deleted ? board : null;
}

/** Live board ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listBoardIds({ includeDeleted = false } = {}) {
  const result = includeDeleted
    ? await query(`SELECT id FROM mood_boards`)
    : await query(`SELECT id FROM mood_boards WHERE deleted = FALSE`);
  return result.rows.map((r) => r.id);
}

export async function createBoard(input) {
  const id = `mb-${randomUUID()}`;
  const board = buildBoardRecord(input, { id });
  await persist(query, board);
  console.log(`🎨 Created mood board: ${id} (${input.name})`);
  return board;
}

// Lock the row, apply `mutate(board)`, persist (unless skipPersist), and return
// the mutator's continuation. Throws NOT_FOUND when the row is absent.
async function withLockedBoard(id, mutate) {
  return withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT data FROM mood_boards WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const board = rowToBoard(sel.rows[0]);
    // A tombstoned board (#1564 soft-delete) is treated as gone for every
    // user-facing mutator — without this, an item add/update/remove or a PATCH
    // after deletion would resurrect the row, bump updatedAt, and re-push a
    // modified tombstone to peers while getBoard 404s the same id.
    // mergeBoardsFromSync (peer tombstone apply) bypasses this path via its own
    // persist, so receiving a tombstone still works.
    if (!board || board.deleted) {
      throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
    }
    const { board: next, result, skipPersist } = mutate(board);
    if (!skipPersist) await persist(client.query.bind(client), next);
    return { board: next, result };
  });
}

export async function updateBoard(id, patch) {
  const { board } = await withLockedBoard(id, (b) => ({ board: applyBoardPatch(b, patch) }));
  return board;
}

/**
 * Faithful conflict-restore (RESTORABLE_FIELDS.moodBoard = name/description/items)
 * wired into conflictJournalResolver. Goes through the row lock + tombstone guard
 * like every other mutator, but uses applyBoardRestore so a "restore my whole
 * version" also brings back items[] (applyBoardPatch only touches name/description).
 */
export async function restoreBoard(id, patch) {
  const { board } = await withLockedBoard(id, (b) => ({ board: applyBoardRestore(b, patch) }));
  return board;
}

export async function deleteBoard(id) {
  // Soft-delete tombstone (#1564) so the deletion federates and an out-of-date
  // peer can't resurrect the board via the LWW merge. The row stays; `deleted`
  // flips and `updatedAt`/`deletedAt` stamp now so the tombstone wins on merge.
  return withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT data FROM mood_boards WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const current = rowToBoard(sel.rows[0]);
    if (!current || current.deleted) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
    const now = new Date().toISOString();
    const next = { ...current, deleted: true, deletedAt: now, updatedAt: now };
    await persist(client.query.bind(client), next);
    return { ok: true };
  });
}

/**
 * Merge an incoming batch of board records from a peer (per-record push). Each
 * record's read-modify-write runs inside `withTransaction` + `SELECT … FOR
 * UPDATE` so a concurrent local edit can't lose to (or clobber) the merge. LWW
 * on `updatedAt` (tombstone-aware) via the shared `mergeBoardRecord` decision —
 * identical contract to mergeProjectsFromSync: seeds/advances the conflict-journal
 * base hash and journals the about-to-be-overwritten local version when remote
 * wins (best-effort, never throws into the merge). Returns `{ applied, count }`.
 */
export async function mergeBoardsFromSync(remoteBoards, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteBoards)) return { applied: false, count: 0 };
  let changed = 0;
  for (const remote of remoteBoards) {
    const applied = await withTransaction(async (client) => {
      const sel = await client.query(`SELECT data FROM mood_boards WHERE id = $1 FOR UPDATE`, [remote?.id]);
      const local = rowToBoard(sel.rows[0]);
      const { next, inserted, remoteWins, changed: didChange } = mergeBoardRecord(local, remote);
      if (!next) return false; // malformed remote → dropped
      if (inserted) {
        await persist(client.query.bind(client), next);
        await setSyncBaseHash('moodBoard', next.id, contentHashForRecord('moodBoard', next));
        return true;
      }
      // local wins, OR remote won but is byte-identical to local (already agree).
      if (!remoteWins || !didChange) return false;
      await maybeJournalBeforeOverwrite({ kind: 'moodBoard', id: next.id, local, remote: next, source });
      await persist(client.query.bind(client), next);
      await setSyncBaseHash('moodBoard', next.id, contentHashForRecord('moodBoard', next));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed === 0) return { applied: false, count: 0 };
  return { applied: true, count: changed };
}

/**
 * Hard-remove tombstoned boards whose deletedAt is older than the cutoff. Called
 * by tombstoneGc once every subscribed peer has acked the deletion. Evicts each
 * pruned board's conflict-journal base hash (mirrors pruneTombstonedProjects).
 */
export async function pruneTombstonedBoards(olderThanMs) {
  if (!Number.isFinite(olderThanMs)) return { pruned: 0 };
  const cutoffIso = new Date(olderThanMs).toISOString();
  const { rows } = await query(
    `DELETE FROM mood_boards
     WHERE deleted = TRUE AND deleted_at IS NOT NULL AND deleted_at < $1
     RETURNING id`,
    [cutoffIso],
  );
  for (const r of rows) await deleteSyncBaseHash('moodBoard', r.id);
  return { pruned: rows.length };
}

export async function addBoardItem(id, itemInput) {
  const { result } = await withLockedBoard(id, (b) => {
    const { board, item } = addItem(b, itemInput);
    return { board, result: item };
  });
  return result;
}

export async function updateBoardItem(id, itemId, patch) {
  const { result } = await withLockedBoard(id, (b) => {
    const { board, item } = updateItem(b, itemId, patch);
    return { board, result: item };
  });
  return result;
}

// ─── Pinterest board link (mood-board importer) ──────────────────────────────

// Link (or re-link) the board to a Pinterest RSS feed.
export async function setPinterestLink(id, link) {
  const { board } = await withLockedBoard(id, (b) => ({ board: applyPinterestLink(b, link) }));
  return board;
}

// Unlink. Skips the write (and peer push) when the board wasn't linked.
export async function clearPinterestLink(id) {
  const { board } = await withLockedBoard(id, (b) => {
    const { board: next, changed } = clearPinterestLinkRecord(b);
    return { board: next, skipPersist: !changed };
  });
  return board;
}

// Append the freshly-downloaded pins in ONE locked write (rather than N
// addBoardItem round-trips) and stamp lastSyncedAt. Always persists so a
// zero-new sync still records the check. Returns { board, added }.
export async function appendPinterestItems(id, imported, opts = {}) {
  const { board, result } = await withLockedBoard(id, (b) => {
    const { board: next, added } = appendPinterestPins(b, imported, opts);
    return { board: next, result: { added } };
  });
  return { board, ...result };
}

export async function removeBoardItem(id, itemId) {
  // Unknown itemId → skip the write entirely (no-op, no updated_at bump). The
  // route still 200s — removing an already-gone item is idempotent.
  const { board } = await withLockedBoard(id, (b) => {
    const { board: next, removed } = removeItem(b, itemId);
    return { board: next, skipPersist: !removed };
  });
  return board;
}
