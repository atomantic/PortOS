import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as history from '../services/history.js';

const historyQuerySchema = z.object({
  limit: z.preprocess(v => (v !== undefined ? Number(v) : undefined), z.number().int().min(1).max(1000).optional()),
  offset: z.preprocess(v => (v !== undefined ? Number(v) : undefined), z.number().int().min(0).optional()),
  action: z.string().optional(),
  target: z.string().optional(),
  success: z.preprocess(v => (v === 'true' ? true : v === 'false' ? false : undefined), z.boolean().optional()),
});

const router = Router();

// GET /api/history - Get history entries
router.get('/', asyncHandler(async (req, res) => {
  const parsed = validateRequest(historyQuerySchema, req.query);
  const options = {
    limit: parsed.limit ?? 100,
    offset: parsed.offset ?? 0,
    action: parsed.action,
    target: parsed.target,
    success: parsed.success,
  };

  res.json(await history.getHistory(options));
}));

// GET /api/history/stats - Get history statistics
router.get('/stats', asyncHandler(async (req, res) => {
  res.json(await history.getHistoryStats());
}));

// GET /api/history/actions - Get unique action types
router.get('/actions', asyncHandler(async (req, res) => {
  res.json(await history.getActionTypes());
}));

// DELETE /api/history/:id - Delete single entry
router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await history.deleteEntry(req.params.id);
  if (!result) throw new ServerError('Entry not found', { status: 404, code: 'NOT_FOUND' });
  res.json(result);
}));

// DELETE /api/history - Clear history
router.delete('/', asyncHandler(async (req, res) => {
  const olderThanDays = req.query.olderThanDays ? parseInt(req.query.olderThanDays, 10) : null;
  res.json(await history.clearHistory(olderThanDays));
}));

export default router;
