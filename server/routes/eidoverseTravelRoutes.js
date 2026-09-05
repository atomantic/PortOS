import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, eidoverseTravelVisitSchema, eidoverseGuestAdmissionSchema, eidoverseGuestChatSchema, eidoverseGuestLeaveSchema } from '../lib/validation.js';
import { getEidoverseTravelCapabilities, listEidoverseDestinations, visitEidoversePeer, receiveEidoverseVisit, receiveEidoverseChat, receiveEidoverseLeave, getEidoverseGuestDescriptor } from '../services/eidoverseTravel.js';

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
  res.json(await receiveEidoverseVisit(req.get('X-PortOS-Instance-Id'), validateRequest(eidoverseGuestAdmissionSchema, req.body)));
}));
router.post('/federation/chat', asyncHandler(async (req, res) => {
  res.json(await receiveEidoverseChat(req.get('X-PortOS-Instance-Id'), validateRequest(eidoverseGuestChatSchema, req.body)));
}));
router.post('/federation/leave', asyncHandler(async (req, res) => {
  res.json(await receiveEidoverseLeave(req.get('X-PortOS-Instance-Id'), validateRequest(eidoverseGuestLeaveSchema, req.body)));
}));
export default router;
