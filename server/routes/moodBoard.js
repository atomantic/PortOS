/**
 * Mood Board Routes — REST surface for board CRUD + inline item ops (issue #911).
 *
 * A board collects visual + textual references that feed the Create suite.
 * Items live inline in the board record, so they're managed through dedicated
 * sub-routes (add/update/remove) rather than a bulk board PATCH — each op locks
 * the board row server-side so concurrent affordances can't clobber each other.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  moodBoardCreateSchema,
  moodBoardUpdateSchema,
  moodBoardItemCreateSchema,
  moodBoardItemUpdateSchema,
  moodBoardPinterestLinkSchema,
  isPaginationRequested,
  paginateArray,
} from '../lib/validation.js';
import {
  listBoards,
  getBoard,
  createBoard,
  updateBoard,
  deleteBoard,
  addBoardItem,
  updateBoardItem,
  removeBoardItem,
  linkPinterestBoard,
  unlinkPinterestBoard,
  syncPinterestBoard,
} from '../services/moodBoard/index.js';

const router = Router();

// Backward-compatible by default: returns the full boards array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const boards = await listBoards();
  if (!isPaginationRequested(req.query)) {
    return res.json(boards);
  }
  res.json(paginateArray(boards, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const board = await getBoard(req.params.id);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  res.json(board);
}));

router.post('/', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardCreateSchema, req.body);
  const board = await createBoard(data);
  res.status(201).json(board);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardUpdateSchema, req.body);
  const updated = await updateBoard(req.params.id, data);
  res.json(updated);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await deleteBoard(req.params.id);
  res.json({ ok: true });
}));

// Pin an item to the board (image-by-media-key/URL or text note).
router.post('/:id/items', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardItemCreateSchema, req.body);
  const item = await addBoardItem(req.params.id, data);
  res.status(201).json(item);
}));

router.patch('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardItemUpdateSchema, req.body);
  const item = await updateBoardItem(req.params.id, req.params.itemId, data);
  res.json(item);
}));

router.delete('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const board = await removeBoardItem(req.params.id, req.params.itemId);
  res.json(board);
}));

// Link the board to a public Pinterest board's RSS feed.
router.put('/:id/pinterest', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardPinterestLinkSchema, req.body);
  const board = await linkPinterestBoard(req.params.id, data);
  res.json(board);
}));

router.delete('/:id/pinterest', asyncHandler(async (req, res) => {
  const board = await unlinkPinterestBoard(req.params.id);
  res.json(board);
}));

// Manual "Sync now" — pull new pins from the linked feed into the board.
router.post('/:id/pinterest/sync', asyncHandler(async (req, res) => {
  const result = await syncPinterestBoard(req.params.id);
  res.json(result);
}));

export default router;
