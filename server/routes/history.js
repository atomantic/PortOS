import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import * as history from '../services/history.js';

const router = Router();

// GET /api/history - Get history entries
router.get('/', asyncHandler(async (req, res) => {
  const options = {
    limit: parseInt(req.query.limit, 10) || 100,
    offset: parseInt(req.query.offset, 10) || 0,
    action: req.query.action || undefined,
    target: req.query.target || undefined,
    success: req.query.success !== undefined ? req.query.success === 'true' : undefined
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
