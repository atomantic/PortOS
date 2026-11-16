import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getStatus, importToPortOS } from '../services/mortalLoomStore.js';

const router = Router();

router.get('/status', asyncHandler(async (_req, res) => {
  const status = await getStatus();
  res.json(status);
}));

router.post('/import', asyncHandler(async (_req, res) => {
  const result = await importToPortOS();
  res.json(result);
}));

export default router;
