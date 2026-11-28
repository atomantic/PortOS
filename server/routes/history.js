import { historyQuerySchema, historyClearQuerySchema } from '../lib/historyValidation.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as history from '../services/history.js';

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
  if (!result?.deleted) throw new ServerError('Entry not found', { status: 404, code: 'NOT_FOUND' });
  res.json(result);
}));

// DELETE /api/history - Clear history
router.delete('/', asyncHandler(async (req, res) => {
  const { olderThanDays } = validateRequest(historyClearQuerySchema, req.query);
  res.json(await history.clearHistory(olderThanDays ?? null));
}));

export default router;
