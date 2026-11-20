import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { maintenance, maintenanceBeginSchema, maintenanceResumeSchema } from '../lib/maintenanceAdmission.js';
import { getMaintenanceStatus, resumeMaintenance } from '../services/maintenanceControl.js';
import { assertHostControl } from '../services/authGate.js';

const router = Router();
router.get('/maintenance', (req, res) => res.json(getMaintenanceStatus()));
router.get('/maintenance/runner-owner/:agentId', asyncHandler(async (req, res) => {
  assertHostControl(req);
  const status = maintenance.status();
  if (status.state === 'unavailable' || !['Local operator', 'Operator session'].includes(status.hold?.owner))
    throw new ServerError('Begin a normal operator maintenance hold before inspection.', { status: 409, code: 'MAINTENANCE_STALE' });
  const { id, revision } = status.hold;
  const { agentId } = req.params;
  if (!/^agent-[a-z0-9-]{1,250}$/i.test(agentId))
    throw new ServerError('Invalid runner agent identity.', { status: 400, code: 'INVALID_AGENT_ID' });
  const { getTerminalRunnerOwner } = await import('../services/maintenanceReservationDisposition.js');
  const owner = await getTerminalRunnerOwner(agentId);
  if (maintenance.status().revision !== status.revision)
    throw new ServerError('Work changed during the activity check. Inspect it again.', { status: 409, code: 'MAINTENANCE_STALE' });
  res.json({ hold: { id, revision }, owner });
}));
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
