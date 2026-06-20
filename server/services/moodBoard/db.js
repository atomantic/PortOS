/**
 * Mood Board — PostgreSQL-backed store (issue #911).
 *
 * One row per board in `mood_boards`: id / name / created_at / updated_at as
 * columns, the full record (name/description/items[]) in `data` JSONB. Mood
 * boards are db-primary and local-only (no federation in v1), modeled on the
 * creativeDirector projectsDB store.
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
  addItem,
  updateItem,
  removeItem,
} from './logic.js';

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
    `INSERT INTO mood_boards (id, name, data, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       name = EXCLUDED.name,
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at`,
    [
      board.id,
      board.name,
      JSON.stringify(board),
      createdAt,
      mirrorTimestamp(board.updatedAt, createdAt),
    ],
  );
  return board;
}

export async function listBoards() {
  // updated_at DESC — most-recently-touched first (the board grid's default).
  const result = await query(
    `SELECT data FROM mood_boards ORDER BY updated_at DESC`,
  );
  return result.rows.map(rowToBoard);
}

export async function getBoard(id) {
  const result = await query(`SELECT data FROM mood_boards WHERE id = $1`, [id]);
  return rowToBoard(result.rows[0]);
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
    if (!board) {
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

export async function deleteBoard(id) {
  const result = await query(`DELETE FROM mood_boards WHERE id = $1`, [id]);
  if (result.rowCount === 0) {
    throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  }
  return { ok: true };
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

export async function removeBoardItem(id, itemId) {
  // Unknown itemId → skip the write entirely (no-op, no updated_at bump). The
  // route still 200s — removing an already-gone item is idempotent.
  const { board } = await withLockedBoard(id, (b) => {
    const { board: next, removed } = removeItem(b, itemId);
    return { board: next, skipPersist: !removed };
  });
  return board;
}
