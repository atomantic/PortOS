/**
 * Versioned, allowlisted peer-provider API. All routes sit behind authGate and
 * additionally require its verified-Basic marker plus a registered peer id.
 */

import { Router, raw } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  federatedMediaIdempotencyKeySchema,
  federatedMediaJobParamsSchema,
  federatedMediaJobSubmissionSchema,
  federatedMediaStatusQuerySchema,
  validateRequest,
} from '../lib/validation.js';
import {
  FEDERATED_MEDIA_ASSET_MAX_BYTES,
  FEDERATED_MEDIA_ASSET_MIME_TYPES,
  FEDERATED_MEDIA_RESULT_EXTENSION,
  federatedMediaAssetIdSchema,
  normalizeRequestedMediaKinds,
} from '../lib/federatedMediaWire.js';
import {
  authorizeFederatedMediaPeer,
  cancelFederatedMediaJob,
  describeFederatedMediaJob,
  getFederatedMediaProviderStatus,
  getFederatedMediaResult,
  submitFederatedMediaJob,
} from '../services/federatedMediaProvider.js';
import {
  describeFederatedMediaAsset,
  storeFederatedMediaAsset,
} from '../services/federatedMedia/assetStore.js';

const router = Router();

// Raw bytes, scoped to this one route and to the image types the store accepts.
// The app-wide express.json() only parses JSON content-types, so an upload
// passes through it untouched and arrives here as a Buffer. The limit is the
// same constant the store enforces, so an oversized body is refused before it
// is buffered rather than after.
const assetBody = raw({ type: FEDERATED_MEDIA_ASSET_MIME_TYPES, limit: FEDERATED_MEDIA_ASSET_MAX_BYTES });

router.get('/status', asyncHandler(async (req, res) => {
  const { config } = await authorizeFederatedMediaPeer(req);
  const { kinds: kindsParam } = validateRequest(federatedMediaStatusQuerySchema, req.query);
  const kinds = normalizeRequestedMediaKinds(kindsParam);
  res.json(await getFederatedMediaProviderStatus(config, { kinds }));
}));

// Conditioning-image upload (ADR
// docs/decisions/2026-08-22-federated-media-input-assets.md rule 1). Bytes go up
// here first and a job body then references the returned id — never a
// filesystem path, and never the bytes inline. Content-addressed, so re-sending
// identical bytes returns the same id and just refreshes the expiry, which is
// what makes a reconcile after a restart cheap.
router.post('/assets', assetBody, asyncHandler(async (req, res) => {
  const { callerId } = await authorizeFederatedMediaPeer(req);
  const stored = await storeFederatedMediaAsset({
    callerId,
    mimeType: (req.get('Content-Type') || '').split(';')[0].trim().toLowerCase(),
    declaredSha256: req.get('X-Content-SHA256'),
    body: req.body,
  });
  res.status(201).json(stored);
}));

// Lets a consumer skip a re-upload after a restart. Absent, expired, and
// another caller's asset all answer 404 — distinguishing them would confirm the
// existence of a peer's asset to someone who is not that peer.
router.get('/assets/:id', asyncHandler(async (req, res) => {
  const { callerId } = await authorizeFederatedMediaPeer(req);
  const assetId = validateRequest(federatedMediaAssetIdSchema, req.params.id);
  res.json(await describeFederatedMediaAsset(callerId, assetId));
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
