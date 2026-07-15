/**
 * Digital Twin settings — read and update.
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { settingsUpdateInputSchema } from '../../lib/digitalTwinValidation.js';

const router = Router();

/**
 * GET /api/digital-twin/settings
 * Get digital twin settings
 */
router.get('/settings', asyncHandler(async (req, res) => {
  const meta = await digitalTwinService.loadMeta();
  res.json(meta.settings);
}));

/**
 * PUT /api/digital-twin/settings
 * Update digital twin settings
 */
router.put('/settings', asyncHandler(async (req, res) => {
  const data = validateRequest(settingsUpdateInputSchema, req.body);
  const settings = await digitalTwinService.updateSettings(data);
  res.json(settings);
}));

export default router;
