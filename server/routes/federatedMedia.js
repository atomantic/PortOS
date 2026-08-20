/**
 * Versioned, allowlisted peer-provider API. All routes sit behind authGate and
 * additionally require its verified-Basic marker plus a registered peer id.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  federatedMediaIdempotencyKeySchema,
  federatedMediaJobParamsSchema,
  federatedMediaJobSubmissionSchema,
  federatedMediaStatusQuerySchema,
  validateRequest,
} from '../lib/validation.js';
import { FEDERATED_MEDIA_RESULT_EXTENSION, normalizeRequestedMediaKinds } from '../lib/federatedMediaWire.js';
import {
  authorizeFederatedMediaPeer,
  cancelFederatedMediaJob,
  describeFederatedMediaJob,
  getFederatedMediaProviderStatus,
  getFederatedMediaResult,
  submitFederatedMediaJob,
} from '../services/federatedMediaProvider.js';

const router = Router();

router.get('/status', asyncHandler(async (req, res) => {
  const { config } = await authorizeFederatedMediaPeer(req);
  const { kinds: kindsParam } = validateRequest(federatedMediaStatusQuerySchema, req.query);
  const kinds = normalizeRequestedMediaKinds(kindsParam);
  res.json(await getFederatedMediaProviderStatus(config, { kinds }));
}));

router.post('/jobs', asyncHandler(async (req, res) => {
  const { callerId, config } = await authorizeFederatedMediaPeer(req);
  const input = validateRequest(federatedMediaJobSubmissionSchema, req.body);
  const idempotencyKey = validateRequest(
    federatedMediaIdempotencyKeySchema,
    req.get('Idempotency-Key'),
  );
  const result = await submitFederatedMediaJob({ callerId, config, input, idempotencyKey });
  res.status(result.replayed ? 200 : 202).json(result.job);
}));

router.get('/jobs/:id', asyncHandler(async (req, res) => {
  const { callerId } = await authorizeFederatedMediaPeer(req);
  const { id } = validateRequest(federatedMediaJobParamsSchema, req.params);
  res.json(await describeFederatedMediaJob(callerId, id));
}));

router.post('/jobs/:id/cancel', asyncHandler(async (req, res) => {
  const { callerId } = await authorizeFederatedMediaPeer(req);
  const { id } = validateRequest(federatedMediaJobParamsSchema, req.params);
  res.json(await cancelFederatedMediaJob(callerId, id));
}));

router.get('/jobs/:id/result', asyncHandler(async (req, res, next) => {
  const { callerId } = await authorizeFederatedMediaPeer(req);
  const { id } = validateRequest(federatedMediaJobParamsSchema, req.params);
  const result = await getFederatedMediaResult(callerId, id);
  const extension = FEDERATED_MEDIA_RESULT_EXTENSION[result.metadata.mimeType] || 'bin';
  res.set({
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${id}.${extension}"`,
    'Content-Length': String(result.metadata.sizeBytes),
    'Content-Type': result.metadata.mimeType,
    'X-Content-SHA256': result.metadata.sha256,
  });
  // sendFile opens after the integrity projection was built, so a user could
  // delete the local result in that narrow window. Replace its filesystem-rich
  // error with the typed provider envelope before it reaches the client.
  res.sendFile(result.path, (err) => {
    if (!err) return;
    next(new ServerError('Provider result became unavailable', {
      status: 410,
      code: 'MEDIA_PROVIDER_RESULT_UNAVAILABLE',
    }));
  });
}));

export default router;
