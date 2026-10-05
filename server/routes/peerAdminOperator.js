import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { peerAdminPeerSchema, peerAdminGrantSchema, peerAdminRemotePlanSchema } from '../lib/peerAdminValidation.js';
import { requireHostControl } from '../services/authGate.js';
import { describePeerAdminSetup, savePeerAdminGrant } from '../services/peerAdministration.js';
import { planPeerAdministration } from '../services/peerAdminConsumer.js';

const router = Router();
router.use(requireHostControl);
router.get('/peers/:peerId', asyncHandler(async (req, res) => {
  const { peerId } = validateRequest(peerAdminPeerSchema, req.params);
  res.set('Cache-Control', 'no-store').json(await describePeerAdminSetup(peerId));
}));
router.post('/grants', asyncHandler(async (req, res) => {
  const input = validateRequest(peerAdminGrantSchema, req.body);
  res.json(await savePeerAdminGrant(input, req));
}));
router.post('/preview', asyncHandler(async (req, res) => {
  const input = validateRequest(peerAdminRemotePlanSchema, req.body);
  res.set('Cache-Control', 'no-store').json(await planPeerAdministration(input));
}));

export default router;
