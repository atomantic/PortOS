import { Router } from 'express';
import { getSettings, updateSettings } from '../services/settings.js';
import {
  setCodexParallelLimit,
  CODEX_PARALLEL_MIN,
  CODEX_PARALLEL_MAX,
  CODEX_PARALLEL_DEFAULT,
} from '../services/mediaJobQueue/index.js';
import { asyncHandler } from '../lib/errorHandler.js';

const router = Router();

// Server-authoritative bounds the client UI can render directly so the form
// clamp never drifts away from what the queue actually enforces. Stitched
// under `imageGen.codex.parallelLimitBounds` since that's where the field
// the bounds describe lives.
const decorateBounds = (settings) => ({
  ...settings,
  imageGen: {
    ...(settings.imageGen || {}),
    codex: {
      ...(settings.imageGen?.codex || {}),
      parallelLimitBounds: {
        min: CODEX_PARALLEL_MIN,
        max: CODEX_PARALLEL_MAX,
        default: CODEX_PARALLEL_DEFAULT,
      },
    },
  },
});

// GET /api/settings
router.get('/', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  const { secrets, ...safe } = settings;
  res.json(decorateBounds(safe));
}));

// PUT /api/settings
router.put('/', asyncHandler(async (req, res) => {
  const merged = await updateSettings(req.body);
  // The queue caches codex.parallelLimit in-process; sync it from the
  // merged value so a save takes effect without a restart and without
  // re-reading the file.
  setCodexParallelLimit(merged.imageGen?.codex?.parallelLimit ?? CODEX_PARALLEL_DEFAULT);
  const { secrets, ...safe } = merged;
  res.json(decorateBounds(safe));
}));

export default router;
