import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getNetworkExposureStatus } from '../lib/networkExposure.js';

const router = Router();

router.get('/status', asyncHandler(async (_req, res) => {
  res.json(getNetworkExposureStatus());
}));

export default router;
