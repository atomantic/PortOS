/**
 * Mood Board Routes — REST surface for board CRUD + inline item ops (issue #911).
 *
 * A board collects visual + textual references that feed the Create suite.
 * Items live inline in the board record, so they're managed through dedicated
 * sub-routes (add/update/remove) rather than a bulk board PATCH — each op locks
 * the board row server-side so concurrent affordances can't clobber each other.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest,
  moodBoardCreateSchema,
  moodBoardUpdateSchema,
  moodBoardItemCreateSchema,
  moodBoardItemUpdateSchema,
  moodBoardPinterestLinkSchema,
  moodBoardXPostImportSchema,
  moodBoardCollageSchema,
  moodBoardExtractFramesSchema,
  isPaginationRequested,
  paginateArray,
} from '../lib/validation.js';
import { influencesSchema, lockedSchema } from './universeBuilder/shared.js';
import { synthesizeBoardStyle } from '../services/moodBoardStyleSynthesis.js';
import { composeBoardPrompt } from '../services/moodBoardCompositeStyle.js';
import { startAnalyzeJob, getAnalyzeJob } from '../services/moodBoard/analyzeJob.js';
import { STYLE_NOTES_MAX } from '../services/universeBuilder.js';
import {
  listBoards,
  listBoardNames,
  getBoard,
  createBoard,
  updateBoard,
  deleteBoard,
  addBoardItem,
  backfillGalleryPrompts,
  updateBoardItem,
  removeBoardItem,
  linkPinterestBoard,
  unlinkPinterestBoard,
  syncPinterestBoard,
  importPrivatePinterestBoard,
  importXPost,
  localizeBoardMedia,
  composeBoardCollage,
  extractItemFrames,
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

// Registered ahead of `/:id` so the literal path is not read as a board id.
router.get('/names', asyncHandler(async (_req, res) => {
  res.json(await listBoardNames());
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

// Board → universe style synthesis (#4188 Phase 4). Stateless like
// /analyze-style-reference: the client sends the universe's CURRENT style
// context (draft values — possibly unsaved), the server reads the board and
// returns a proposal + diff. Persistence happens only through the universe's
// queued-write adopt endpoint after the user reviews the diff.
const synthesizeStyleSchema = z.object({
  styleNotes: z.string().trim().max(STYLE_NOTES_MAX).optional().default(''),
  influences: influencesSchema.optional().default({ embrace: [], avoid: [] }),
  locked: lockedSchema.optional().default({}),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
}).strict();
router.post('/:id/synthesize-style', asyncHandler(async (req, res) => {
  const body = validateRequest(synthesizeStyleSchema, req.body ?? {});
  const board = await getBoard(req.params.id);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  res.json(await synthesizeBoardStyle({ board, ...body }));
}));

// Board-level composite prompt. Reads the per-item analyses already stored on
// the board (prompt-from-media), distills one still-image prompt, and persists
// it as `board.style`. The page then renders that prompt as the poster.
const composePromptSchema = z.object({
  providerId: z.string().trim().max(128).optional(),
  model: z.string().trim().max(256).optional(),
}).strict();
// Copy gallery generation prompts onto pins that lack any prompt, so the board
// analyze step doesn't re-run vision on them. Resolves to the updated board.
router.post('/:id/backfill-prompts', asyncHandler(async (req, res) => {
  const board = await backfillGalleryPrompts(req.params.id);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  res.json(board);
}));

// Background analyze job: prompt-from-media over un-analyzed pins, then compose
// the board style. Survives the page unmounting; progress follows the
// `mood-board:analyze` socket event and GET restores it on return.
const analyzeSchema = composePromptSchema.extend({
  providerId: z.string().trim().min(1).max(128),
}).strict();
router.post('/:id/analyze', asyncHandler(async (req, res) => {
  const body = validateRequest(analyzeSchema, req.body ?? {});
  const board = await getBoard(req.params.id);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  res.status(202).json(startAnalyzeJob(req.params.id, body));
}));

router.get('/:id/analyze', asyncHandler(async (req, res) => {
  res.json(getAnalyzeJob(req.params.id));
}));

router.post('/:id/compose-prompt', asyncHandler(async (req, res) => {
  const body = validateRequest(composePromptSchema, req.body ?? {});
  const board = await getBoard(req.params.id);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  const style = await composeBoardPrompt({ board, ...body });
  res.json(await updateBoard(req.params.id, { style }));
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

// One-shot import through the signed-in PortOS CDP browser. No Pinterest
// credentials are stored and this does not create a background sync.
router.post('/:id/pinterest/import', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardPinterestLinkSchema, req.body);
  const result = await importPrivatePinterestBoard(req.params.id, data);
  res.json(result);
}));

// One-shot import: paste a public x.com/twitter.com post URL, pull its
// attached photos/video into the board.
router.post('/:id/x-post', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardXPostImportSchema, req.body);
  const result = await importXPost(req.params.id, data);
  res.json(result);
}));

// Re-host every external image URL on the board into the local gallery.
router.post('/:id/localize-media', asyncHandler(async (req, res) => {
  res.json(await localizeBoardMedia(req.params.id));
}));

// Compile every image (and sampled video frames) into one square-ish grid image
// saved to the gallery.
router.post('/:id/collage', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardCollageSchema, req.body ?? {});
  res.json(await composeBoardCollage(req.params.id, data));
}));

// Sample N frames from a video pin and append them to the board as image items.
router.post('/:id/items/:itemId/extract-frames', asyncHandler(async (req, res) => {
  const data = validateRequest(moodBoardExtractFramesSchema, req.body);
  res.json(await extractItemFrames(req.params.id, req.params.itemId, data));
}));

export default router;
