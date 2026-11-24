/**
 * Feature priority API: the resolved tier per feature area, pin updates and the focused-visit beacon.
 *
 * `POST /visit` is the usage signal. It accepts only an operator caller: a paired peer or a basic-auth caller is refused, and a session minted for a spawned agent (`label: 'agent'`) is skipped, so an agent driving a page does not teach PortOS that a feature is in use.
 * That check is inert on a password-free install, which is why the client counts focused dwell instead of requests.
 * Errors reach the central middleware.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { featurePriorityAreaIdSchema, featurePriorityUpdateSchema, featureVisitSchema } from '../lib/featurePriorityValidation.js';
import { verifyRequestSessionIdentity } from '../services/auth.js';
import { getFeaturePriorities, recordVisit, setFeaturePriorityPin } from '../services/featurePriorities.js';

const router = Router();

const REFUSED_METHODS = new Set(['peer', 'basic']);

// GET /api/feature-priorities — `{ areas, evidenceDays, minEvidenceDays }`.
router.get('/', asyncHandler(async (_req, res) => {
  res.json(await getFeaturePriorities());
}));

// POST /api/feature-priorities/visit — one focused-dwell beacon per route per page session.
router.post('/visit', asyncHandler(async (req, res) => {
  if (REFUSED_METHODS.has(req.portosAuthContext?.method)) {
    throw new ServerError('Feature visits are recorded for the operator only', { status: 403, code: 'OPERATOR_REQUIRED' });
  }
  const { path } = validateRequest(featureVisitSchema, req.body ?? {});
  const session = await verifyRequestSessionIdentity(req);
  if (session?.label === 'agent') return res.json({ recorded: false });
  res.json(await recordVisit(path));
}));

// PUT /api/feature-priorities/:areaId — pin a tier, or clear the pin with `{ tier: null }`.
router.put('/:areaId', asyncHandler(async (req, res) => {
  const areaId = validateRequest(featurePriorityAreaIdSchema, req.params.areaId);
  const { tier } = validateRequest(featurePriorityUpdateSchema, req.body ?? {});
  const result = await setFeaturePriorityPin(areaId, tier);
  req.app.get('io')?.emit('feature-priorities:updated', result);
  res.json(result);
}));

export default router;
