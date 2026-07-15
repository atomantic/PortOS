/**
 * Digital Twin status summary.
 *
 *   GET / → status summary
 */

import { Router } from 'express';
import * as digitalTwinService from '../../services/digital-twin.js';
import { asyncHandler } from '../../lib/errorHandler.js';

const router = Router();

/**
 * GET /api/digital-twin
 * Get digital twin status summary
 */
router.get('/', asyncHandler(async (req, res) => {
  const status = await digitalTwinService.getDigitalTwinStatus();
  res.json(status);
}));

export default router;
