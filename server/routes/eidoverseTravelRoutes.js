import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { eidoverseTravelVisitSchema, eidoverseGuestAdmissionSchema, eidoverseGuestChatSchema, eidoverseGuestLeaveSchema } from '../lib/eidoverseValidation.js';
import { getEidoverseTravelCapabilities, listEidoverseDestinations, visitEidoversePeer, authorizeEidoverseFederationPeer, receiveEidoverseVisit, receiveEidoverseChat, receiveEidoverseLeave, getEidoverseGuestDescriptor } from '../services/eidoverseTravel.js';

const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/destinations', asyncHandler(async (_req, res) => {
  res.json(await listEidoverseDestinations());
}));
router.post('/depart', asyncHandler(async (req, res) => {
  const args = validateRequest(eidoverseTravelVisitSchema, req.body);
  res.json(await visitEidoversePeer({ ...args, agent: false }));
}));
// The only public endpoint: its bearer ticket yields no owner/session credentials.
router.get('/guest', asyncHandler(async (req, res) => {
  res.json(await getEidoverseGuestDescriptor(req.get('X-Eidoverse-Guest')));
}));
router.get('/federation/capabilities', asyncHandler(async (_req, res) => {
  res.json(await getEidoverseTravelCapabilities());
}));
router.post('/federation/visit', asyncHandler(async (req, res) => {
  res.json(await receiveEidoverseVisit(await authorizeEidoverseFederationPeer(req), validateRequest(eidoverseGuestAdmissionSchema, req.body)));
}));
router.post('/federation/chat', asyncHandler(async (req, res) => {
  res.json(await receiveEidoverseChat(await authorizeEidoverseFederationPeer(req), validateRequest(eidoverseGuestChatSchema, req.body)));
}));
router.post('/federation/leave', asyncHandler(async (req, res) => {
  res.json(await receiveEidoverseLeave(await authorizeEidoverseFederationPeer(req), validateRequest(eidoverseGuestLeaveSchema, req.body)));
}));
export default router;
