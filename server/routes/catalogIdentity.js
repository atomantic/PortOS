import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { requireHostControl } from '../services/authGate.js';
import { identityPreviewSchema, identityCreateSchema, identityImportSchema, identityAcceptSchema,
  identityEmptySchema, identitySnapshotQuerySchema, identityStatusQuerySchema, identityListQuerySchema } from '../lib/catalogIdentityValidation.js';
import * as identity from '../services/catalogIdentity/index.js';
import { authenticateIdentityPeer, signEvidence, localIdentity } from '../services/catalogIdentity/transport.js';
import { catalogIdentityEvents } from '../services/catalogIdentity/events.js';

const router = Router();
router.get('/peer/snapshot', asyncHandler(async (req, res) => {
  const params = validateRequest(identitySnapshotQuerySchema, req.query);
  const peer = await authenticateIdentityPeer(req);
  const owner = await localIdentity();
  const value = await identity.ownerSnapshot(params.ingredientId, owner);
  const currentPeer = await authenticateIdentityPeer(req);
  if (await localIdentity() !== owner || currentPeer.instanceId !== peer.instanceId) throw new ServerError('Owner binding changed', { status: 409 });
  res.set('Cache-Control', 'no-store').json(signEvidence(currentPeer, { owner, challenge: params.challenge,
    kind: 'snapshot', target: params.ingredientId, value }));
}));
router.get('/peer/status', asyncHandler(async (req, res) => {
  const params = validateRequest(identityStatusQuerySchema, req.query);
  const peer = await authenticateIdentityPeer(req);
  const owner = await localIdentity();
  const value = await identity.peerIdentityStatus(params.operationId, peer.instanceId);
  const currentPeer = await authenticateIdentityPeer(req);
  if (await localIdentity() !== owner || currentPeer.instanceId !== peer.instanceId) throw new ServerError('Owner binding changed', { status: 409 });
  res.set('Cache-Control', 'no-store').json(signEvidence(currentPeer, { owner, challenge: params.challenge,
    kind: 'status', target: params.operationId, value }));
}));
router.use(requireHostControl);
router.get('/', asyncHandler(async (req, res) => {
  const params = validateRequest(identityListQuerySchema, req.query);
  res.set('Cache-Control', 'no-store').json(await identity.listIdentityOperations(params));
}));
router.get('/:id', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store').json(await identity.getIdentityOperation(req.params.id));
}));
function changed(result, res) {
  catalogIdentityEvents.emit('changed', { operationId: result.id, sourceId: result.sourceId, survivorId: result.survivorId });
  res.set('Cache-Control', 'no-store').json(result);
}
router.post('/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(identityPreviewSchema, req.body);
  res.set('Cache-Control', 'no-store').json(await identity.previewIdentity(body));
}));
router.post('/create', asyncHandler(async (req, res) => {
  const body = validateRequest(identityCreateSchema, req.body);
  changed(await identity.createIdentity(body), res);
}));
router.post('/import', asyncHandler(async (req, res) => {
  const body = validateRequest(identityImportSchema, req.body);
  changed(await identity.importIdentity(body), res);
}));
router.post('/:id/accept', asyncHandler(async (req, res) => {
  const body = validateRequest(identityAcceptSchema, req.body);
  changed(await identity.acceptIdentity(req.params.id, body.planHash), res);
}));
router.post('/:id/advance', asyncHandler(async (req, res) => {
  validateRequest(identityEmptySchema, req.body ?? {});
  changed(await identity.advanceIdentity(req.params.id), res);
}));
router.post('/:id/abort', asyncHandler(async (req, res) => {
  validateRequest(identityEmptySchema, req.body ?? {});
  changed(await identity.abortIdentity(req.params.id), res);
}));
router.post('/:id/recover', asyncHandler(async (req, res) => {
  const body = validateRequest(identityAcceptSchema, req.body);
  changed(await identity.prepareIdentityRecovery(req.params.id, body.planHash), res);
}));
export default router;
