import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { peerAdminPeerSchema, peerAdminGrantSchema, peerAdminRemotePlanSchema, peerExecutionGrantSchema, peerExecutionRemoteDispatchSchema, peerExecutionRemoteStatusSchema } from '../lib/peerAdminValidation.js';
import { requireHostControl } from '../services/authGate.js';
import { describePeerAdminSetup, savePeerAdminGrant } from '../services/peerAdministration.js';
import { planPeerAdministration, preparePeerExecution, dispatchPeerExecution, getPeerExecutionStatus } from '../services/peerAdminConsumer.js';

async function setup(peerId) {
  const result = await describePeerAdminSetup(peerId);
  const { peerExecutionRuntime } = await import('../services/peerExecutionRuntime.js');
  return { ...result, execution: await (await peerExecutionRuntime()).describe(peerId) };
}
const router = Router();
router.use(requireHostControl);
router.get('/peers/:peerId', asyncHandler(async (req, res) => {
  const { peerId } = validateRequest(peerAdminPeerSchema, req.params);
  res.set('Cache-Control', 'no-store').json(await setup(peerId));
}));
router.post('/grants', asyncHandler(async (req, res) => {
  const input = validateRequest(peerAdminGrantSchema, req.body);
  await savePeerAdminGrant(input, req);
  res.json(await setup(input.peerId));
}));
router.post('/preview', asyncHandler(async (req, res) => {
  const input = validateRequest(peerAdminRemotePlanSchema, req.body);
  res.set('Cache-Control', 'no-store').json(await planPeerAdministration(input));
}));

router.post('/execution-grants', asyncHandler(async (req, res) => {
  const input = validateRequest(peerExecutionGrantSchema, req.body);
  const { peerExecutionRuntime } = await import('../services/peerExecutionRuntime.js');
  await (await peerExecutionRuntime()).saveGrant(input, req);
  res.json(await setup(input.peerId));
}));
router.post('/execution-preview', asyncHandler(async (req, res) => {
  const input = validateRequest(peerAdminRemotePlanSchema, req.body);
  res.set('Cache-Control', 'no-store').json(await preparePeerExecution(input));
}));
router.post('/execution-dispatch', asyncHandler(async (req, res) => {
  const input = validateRequest(peerExecutionRemoteDispatchSchema, req.body);
  res.set('Cache-Control', 'no-store').json(await dispatchPeerExecution(input));
}));
router.post('/execution-status', asyncHandler(async (req, res) => {
  const input = validateRequest(peerExecutionRemoteStatusSchema, req.body);
  res.set('Cache-Control', 'no-store').json(await getPeerExecutionStatus(input));
}));
const catalogQuerySchema = z.object({ backend: z.literal('lmstudio'), catalogKey: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/) }).strict();
router.get('/catalog-review', asyncHandler(async (req, res) => {
  const input = validateRequest(catalogQuerySchema, req.query);
  const { describePeerCatalogReview } = await import('../services/peerCatalogInstaller.js');
  res.set('Cache-Control', 'no-store').json(await describePeerCatalogReview(input));
}));
router.get('/catalog-reviews', asyncHandler(async (_req, res) => {
  const { listPeerCatalogReviews } = await import('../services/peerCatalogInstaller.js');
  res.set('Cache-Control', 'no-store').json(await listPeerCatalogReviews());
}));
router.put('/catalog-review', asyncHandler(async (req, res) => {
  const { peerCatalogReviewSchema, savePeerCatalogReview } = await import('../services/peerCatalogInstaller.js');
  const input = validateRequest(peerCatalogReviewSchema, req.body);
  const result = await savePeerCatalogReview(input, req);
  const { peerExecutionRuntime } = await import('../services/peerExecutionRuntime.js');
  (await peerExecutionRuntime()).notify();
  res.json(result);
}));
export default router;
