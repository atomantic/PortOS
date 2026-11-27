import { Router } from 'express';
import { mortalLoomRecoverySchema, mortalLoomRestoreSchema } from '../lib/mortalLoomValidation.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { requireHostControl } from '../services/authGate.js';
import { exportMortalLoomRecoveryCopy, getStatus, importToPortOS, restoreMortalLoomSnapshot } from '../services/mortalLoomStore.js';

const router = Router();

router.get('/status', asyncHandler(async (_req, res) => {
  const status = await getStatus();
  res.json(status);
}));

router.post('/import', asyncHandler(async (_req, res) => {
  const result = await importToPortOS();
  res.json(result);
}));

router.post('/restore', requireHostControl, asyncHandler(async (req, res) => {
  res.json(await restoreMortalLoomSnapshot(validateRequest(mortalLoomRestoreSchema, req.body)));
}));

router.post('/recovery/download', requireHostControl, asyncHandler(async (req, res) => {
  const { id } = validateRequest(mortalLoomRecoverySchema, req.body);
  const bytes = await exportMortalLoomRecoveryCopy(id);
  res.set('Cache-Control', 'no-store');
  res.attachment('MortalLoom-Recovery.json').type('application/json').send(bytes);
}));

export default router;
