import { Router } from 'express';
import { getSettings, updateSettings } from '../services/settings.js';
import { setCodexParallelLimit, CODEX_PARALLEL_DEFAULT } from '../services/mediaJobQueue/index.js';
import { asyncHandler } from '../lib/errorHandler.js';

const router = Router();

// GET /api/settings
router.get('/', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const { secrets, ...safe } = settings;
  res.json(safe);
}));

// PUT /api/settings
router.put('/', asyncHandler(async (req, res) => {
  const merged = await updateSettings(req.body);
  // The queue caches codex.parallelLimit in-process; sync it from the
  // merged value so a save takes effect without a restart and without
  // re-reading the file.
  setCodexParallelLimit(merged.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
  const { secrets, ...safe } = merged;
  res.json(safe);
}));

export default router;
