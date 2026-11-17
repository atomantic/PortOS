import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { requireHostControl } from '../services/authGate.js';
import { deleteMaintenance, getMaintenanceInventory } from '../services/dataMaintenance.js';

const router = Router();
const paramsSchema = z.object({ operationId: z.string().min(1).max(100) });
router.get('/', requireHostControl, asyncHandler(async (_req, res) => res.json(await getMaintenanceInventory())));
// Non-GET host-control gating comes from hostControlRouteGate at the app mount.
router.delete('/:operationId', asyncHandler(async (req, res) => {
  const { operationId } = validateRequest(paramsSchema, req.params);
  res.json(await deleteMaintenance(operationId));
}));
export default router;
