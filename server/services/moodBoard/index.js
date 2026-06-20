/**
 * Mood Board service — public entry (issue #911).
 *
 * Mood boards are db-primary, local-only records (no file backend, no
 * federation in v1), so the public surface is just the Postgres store. The
 * pure transforms live in logic.js (unit-tested without a DB); db.js does the
 * row I/O + per-board row locking. Routes import from here.
 */

export {
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  deleteBoard,
  addBoardItem,
  updateBoardItem,
  removeBoardItem,
} from './db.js';
