import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { buildEidoverseGuestCookie } from '../lib/eidoverseGuestCookie.js';
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
  const ticket = req.get('X-Eidoverse-Guest');
  const descriptor = await getEidoverseGuestDescriptor(ticket);
  // The renderer's own requests cannot carry a header, so the same ticket
  // travels as a cookie that only the Eidoverse proxy honors.
  res.append('Set-Cookie', buildEidoverseGuestCookie(ticket, {
    expiresAt: descriptor.expiresAt,
    secure: req.secure || req.get('X-Forwarded-Proto') === 'https',
  }));
  res.json(descriptor);
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
