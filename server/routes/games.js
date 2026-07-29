/**
 * Game studio REST surface (#3177).
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  gameCreateSchema,
  gameFeedbackSchema,
  gameMusicBindingSchema,
  gameSpriteBindingSchema,
  gameUpdateSchema,
  validateRequest,
} from '../lib/validation.js';
import {
  bindMusic,
  bindSprite,
  compileGameAssets,
  createGame,
  deleteGame,
  getGame,
  getGameIntegrity,
  listGames,
  requestGameFeedback,
  unbindMusic,
  unbindSprite,
  updateGame,
} from '../services/games/index.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listGames());
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

router.post('/:id/compile', asyncHandler(async (req, res) => {
  res.json(await compileGameAssets(req.params.id));
}));

router.post('/:id/feedback', asyncHandler(async (req, res) => {
  const input = validateRequest(gameFeedbackSchema, req.body);
  res.status(201).json(await requestGameFeedback(req.params.id, input));
}));

export default router;
