/**
 * Which machines hold each media file, and Make primary (services/mediaHolders.js).
 *
 *   GET  /api/media/holders          → { self, items: { '<kind>:<filename>': { holders, primaryInstanceId } } }
 *   POST /api/media/holders/primary  { kind, filename, instanceId } → keep that holder's copy, release the rest
 */
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { mediaMakePrimarySchema, validateRequest } from '../lib/validation.js';
import { listMediaHolders, makeMediaPrimary } from '../services/mediaHolders.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await listMediaHolders());
}));

router.post('/primary', asyncHandler(async (req, res) => {
  res.json(await makeMediaPrimary(validateRequest(mediaMakePrimarySchema, req.body ?? {})));
}));

export default router;
