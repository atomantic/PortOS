import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getItermStatus } from '../services/itermBridge.js';

const router = Router();

// GET /api/iterm/status — capability state only ({ state, detail }), never
// session contents: the iTerm2 view's hint line names the fix for each state.
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await getItermStatus());
}));

export default router;
