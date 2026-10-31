/**
 * Where each media file is used (services/mediaUsage.js).
 *
 *   GET /api/media/usages → { items: { '<kind>:<ref>': [{ source, label, id, title, role, href }] } }
 */
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getMediaUsageIndex } from '../services/mediaUsage.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json({ items: await getMediaUsageIndex() });
}));

export default router;
