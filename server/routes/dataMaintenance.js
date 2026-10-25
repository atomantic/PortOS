import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { requireHostControl } from '../services/authGate.js';
import { executeMaintenance, getMaintenanceInventory, previewMaintenance } from '../services/dataMaintenance.js';

const router = Router();
const previewSchema = z.object({ operationId: z.string().min(1).max(100) }).strict();
const executeSchema = z.object({ token: z.string().uuid(), confirmation: z.string().max(150) }).strict();
router.use(requireHostControl);
router.get('/', asyncHandler(async (_req, res) => res.json(await getMaintenanceInventory())));
router.post('/preview', asyncHandler(async (req, res) => {
  const { operationId } = validateRequest(previewSchema, req.body);
  res.json(await previewMaintenance(operationId));
}));
router.post('/execute', asyncHandler(async (req, res) => {
  const body = validateRequest(executeSchema, req.body);
  res.json(await executeMaintenance(body));
}));
export default router;
