import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  peerAdminPreflightSchema, peerAdminPlanSchema, peerAdminReceiptSchema,
} from '../lib/peerAdminValidation.js';
import {
  createPeerAdminPreflight,
  createPeerAdminPlan, getPeerAdminPlan, rejectPeerAdminExecution,
} from '../services/peerAdministration.js';

const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.post('/preflight', asyncHandler(async (req, res) => {
  const input = validateRequest(peerAdminPreflightSchema, req.body);
  res.json(await createPeerAdminPreflight(req, input));
}));
router.post('/plans', asyncHandler(async (req, res) => {
  const input = validateRequest(peerAdminPlanSchema, req.body);
  // A plan is a preview, not accepted/queued work: deliberately HTTP 200.
  res.json(await createPeerAdminPlan(req, input));
}));
router.post('/receipt', asyncHandler(async (req, res) => {
  const { requestId } = validateRequest(peerAdminReceiptSchema, req.body);
  res.json(await getPeerAdminPlan(req, requestId));
}));
router.post('/execute', asyncHandler(async (req, _res) => {
  const { requestId } = validateRequest(peerAdminReceiptSchema, req.body);
  await rejectPeerAdminExecution(req, requestId);
}));
export default router;
