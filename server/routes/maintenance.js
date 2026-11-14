import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { maintenance, maintenanceBeginSchema, maintenanceResumeSchema } from '../lib/maintenanceAdmission.js';
import { resumeMaintenance } from '../services/maintenanceControl.js';

const router = Router();
router.get('/maintenance', (req, res) => res.json(maintenance.status()));
router.post('/maintenance', asyncHandler(async (req, res) => {
  const { reason } = validateRequest(maintenanceBeginSchema, req.body);
  const owner = req.portosAuthContext?.method === 'session' ? 'Operator session' : 'Local operator';
  res.json(maintenance.begin({ reason, owner }));
}));
router.post('/maintenance/resume', asyncHandler(async (req, res) => {
  const input = validateRequest(maintenanceResumeSchema, req.body);
  res.json(await resumeMaintenance(input));
}));
export default router;
