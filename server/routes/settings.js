import { Router } from 'express';
import { getSettings, updateSettings } from '../services/settings.js';
import { asyncHandler } from '../lib/errorHandler.js';

const router = Router();

// GET /api/settings
router.get('/', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.json(settings);
}));

// PUT /api/settings
router.put('/', asyncHandler(async (req, res) => {
  const merged = await updateSettings(req.body);
  res.json(merged);
}));

export default router;
