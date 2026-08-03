/**
 * Game studio REST surface (#3177).
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  gameCreateSchema,
  gameArtworkBindingSchema,
  gameArtworkBindingUpdateSchema,
  gameArtworkPublishSchema,
  gameFeedbackSchema,
  gameMusicBindingSchema,
  gameSpriteBindingSchema,
  gameUpdateSchema,
  isPaginationRequested,
  paginateArray,
  validateRequest,
} from '../lib/validation.js';
import {
  bindMusic,
  bindArtwork,
  bindSprite,
  compileGameAssets,
  createGame,
  deleteGame,
  getGame,
  getGameIntegrity,
  listGames,
  publishGameArtwork,
  requestGameFeedback,
  unbindMusic,
  unbindArtwork,
  unbindSprite,
  updateArtwork,
  updateGame,
} from '../services/games/index.js';

const router = Router();

// Backward-compatible by default: returns the full games array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const games = await listGames();
  if (!isPaginationRequested(req.query)) {
    return res.json(games);
  }
  res.json(paginateArray(games, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(gameCreateSchema, req.body);
  res.status(201).json(await createGame(input));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const game = await getGame(req.params.id);
  if (!game) throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  res.json(game);
}));

router.get('/:id/integrity', asyncHandler(async (req, res) => {
  const integrity = await getGameIntegrity(req.params.id);
  if (!integrity) throw new ServerError('Game not found', { status: 404, code: 'NOT_FOUND' });
  res.json(integrity);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(gameUpdateSchema, req.body);
  res.json(await updateGame(req.params.id, patch));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await deleteGame(req.params.id));
}));

router.post('/:id/sprites', asyncHandler(async (req, res) => {
  const binding = validateRequest(gameSpriteBindingSchema, req.body);
  res.status(201).json(await bindSprite(req.params.id, binding));
}));

router.delete('/:id/sprites/:spriteId', asyncHandler(async (req, res) => {
  res.json(await unbindSprite(req.params.id, req.params.spriteId));
}));

router.post('/:id/music', asyncHandler(async (req, res) => {
  const binding = validateRequest(gameMusicBindingSchema, req.body);
  res.status(201).json(await bindMusic(req.params.id, binding));
}));

router.delete('/:id/music/:bindingId', asyncHandler(async (req, res) => {
  res.json(await unbindMusic(req.params.id, req.params.bindingId));
}));

router.post('/:id/artwork', asyncHandler(async (req, res) => {
  const binding = validateRequest(gameArtworkBindingSchema, req.body);
  res.status(201).json(await bindArtwork(req.params.id, binding));
}));

router.patch('/:id/artwork/:bindingId', asyncHandler(async (req, res) => {
  const patch = validateRequest(gameArtworkBindingUpdateSchema, req.body);
  res.json(await updateArtwork(req.params.id, req.params.bindingId, patch));
}));

router.delete('/:id/artwork/:bindingId', asyncHandler(async (req, res) => {
  res.json(await unbindArtwork(req.params.id, req.params.bindingId));
}));

router.post('/:id/artwork/:bindingId/publish', asyncHandler(async (req, res) => {
  const options = validateRequest(gameArtworkPublishSchema, req.body || {});
  res.json(await publishGameArtwork(req.params.id, req.params.bindingId, options));
}));

router.post('/:id/compile', asyncHandler(async (req, res) => {
  res.json(await compileGameAssets(req.params.id));
}));

router.post('/:id/feedback', asyncHandler(async (req, res) => {
  const input = validateRequest(gameFeedbackSchema, req.body);
  res.status(201).json(await requestGameFeedback(req.params.id, input));
}));

export default router;
