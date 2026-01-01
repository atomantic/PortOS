import { Router } from 'express';
import * as history from '../services/history.js';

const router = Router();

// GET /api/history - Get history entries
router.get('/', async (req, res, next) => {
  const options = {
    limit: parseInt(req.query.limit) || 100,
    offset: parseInt(req.query.offset) || 0,
    action: req.query.action || undefined,
    target: req.query.target || undefined,
    success: req.query.success !== undefined ? req.query.success === 'true' : undefined
  };

  const result = await history.getHistory(options).catch(next);
  if (result) res.json(result);
});

// GET /api/history/stats - Get history statistics
router.get('/stats', async (req, res, next) => {
  const stats = await history.getHistoryStats().catch(next);
  if (stats) res.json(stats);
});

// GET /api/history/actions - Get unique action types
router.get('/actions', async (req, res, next) => {
  const actions = await history.getActionTypes().catch(next);
  if (actions) res.json(actions);
});

// DELETE /api/history - Clear history
router.delete('/', async (req, res, next) => {
  const olderThanDays = req.query.olderThanDays ? parseInt(req.query.olderThanDays) : null;
  const result = await history.clearHistory(olderThanDays).catch(next);
  if (result) res.json(result);
});

export default router;
