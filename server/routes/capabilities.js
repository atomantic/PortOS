import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getCapabilitiesSnapshot } from '../services/capabilitiesSnapshot.js';

const router = Router();
router.get('/', asyncHandler(async (req, res) => {
  res.json(await getCapabilitiesSnapshot());
}));
export default router;
