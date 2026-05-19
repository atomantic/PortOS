/**
 * Sharing routes — cross-network share buckets via cloud-synced folders.
 *
 *   GET    /api/sharing/buckets               → list registered buckets
 *   POST   /api/sharing/buckets               → register a new bucket
 *   PUT    /api/sharing/buckets/:id           → patch bucket (name/mode/overrides)
 *   DELETE /api/sharing/buckets/:id           → unregister + detach watcher
 *   POST   /api/sharing/buckets/:id/export    → export series/universe/media
 *   GET    /api/sharing/buckets/:id/inbox     → list pending imports
 *   POST   /api/sharing/buckets/:id/inbox/:manifestId/promote → adopt into local state
 *   POST   /api/sharing/buckets/:id/inbox/:manifestId/dismiss → drop from inbox
 *   GET    /api/sharing/buckets/:id/activity  → recent manifests (in/out)
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  bucketCreateSchema, bucketUpdateSchema, sharingExportSchema, subscriptionCreateSchema,
} from '../lib/validation.js';
import {
  listBuckets, getBucket, createBucket, updateBucket, deleteBucket, readBucketJson,
} from '../services/sharing/buckets.js';
import { SHARING_SCHEMA_VERSION } from '../services/sharing/version.js';
import { attachWatcher, detachWatcher } from '../services/sharing/watcher.js';
import { exportByKind } from '../services/sharing/exporter.js';
import {
  listInbox, promoteInboxItem, dismissInboxItem, processBacklog,
} from '../services/sharing/importer.js';
import {
  listSubscriptions, subscribe, unsubscribe,
} from '../services/sharing/subscriptions.js';
import { listManifestFilenames, readManifest } from '../services/sharing/manifest.js';

const router = Router();

/**
 * Map sharing-service error codes onto HTTP statuses so the rest of PortOS's
 * REST conventions hold (404 for not-found, 400 for client validation, 409
 * for transient conflict like "still syncing"). Bare `Error`s thrown by the
 * services carry a string `code` but no `status`, so `normalizeError`
 * defaults them to 500 unless we re-throw them through `ServerError` with
 * the right status here.
 *
 * Pattern mirrors `server/routes/mediaCollections.js` and
 * `server/routes/pipeline.js`: the mapper returns the (possibly-rewrapped)
 * error and the call site re-throws it, so control flow reads like a normal
 * `.catch(mapAndRethrow)`.
 */
const SHARING_ERROR_STATUS = {
  SHARING_BUCKET_NOT_FOUND: 404,
  SHARING_INBOX_NOT_FOUND: 404,
  SHARING_SUBSCRIPTION_NOT_FOUND: 404,
  SHARING_BUCKET_VALIDATION: 400,
  SHARING_BUCKET_PATH_UNUSABLE: 400,
  SHARING_SUBSCRIPTION_VALIDATION: 400,
  SHARING_RECORDS_PENDING: 409,
  SHARING_ASSETS_PENDING: 409,
  SHARING_UNIVERSE_PENDING: 409,
  SHARING_SERIES_PENDING: 409,
};

const mapSharingError = (err) => {
  const status = SHARING_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

const rethrowSharingError = (err) => { throw mapSharingError(err); };

/** Hydrate a bucket with its on-disk bucket.json so the UI sees the bucket's
 *  protocol version (which may differ from the local SHARING_SCHEMA_VERSION
 *  when bumps roll out across peers).
 */
async function hydrateBucket(bucket) {
  const bucketJson = await readBucketJson(bucket).catch(() => null);
  const remoteSchema = bucketJson?.sharingSchemaVersion ?? bucketJson?.schemaVersion ?? null;
  return {
    ...bucket,
    bucketJson,
    bucketSchemaVersion: remoteSchema,
    localSchemaVersion: SHARING_SCHEMA_VERSION,
    schemaCompatible: remoteSchema === null || remoteSchema <= SHARING_SCHEMA_VERSION,
  };
}

router.get('/buckets', asyncHandler(async (req, res) => {
  const buckets = await listBuckets();
  const hydrated = await Promise.all(buckets.map(hydrateBucket));
  res.json({ buckets: hydrated, localSchemaVersion: SHARING_SCHEMA_VERSION });
}));

router.get('/buckets/:id', asyncHandler(async (req, res) => {
  const bucket = await getBucket(req.params.id).catch(rethrowSharingError);
  res.json({ bucket: await hydrateBucket(bucket), localSchemaVersion: SHARING_SCHEMA_VERSION });
}));

router.post('/buckets', asyncHandler(async (req, res) => {
  const input = validateRequest(bucketCreateSchema, req.body || {});
  const bucket = await createBucket(input).catch(rethrowSharingError);
  await attachWatcher(bucket.id);
  await processBacklog(bucket.id);
  res.status(201).json({ bucket: await hydrateBucket(bucket) });
}));

router.put('/buckets/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(bucketUpdateSchema, req.body || {});
  const bucket = await updateBucket(req.params.id, patch).catch(rethrowSharingError);
  res.json({ bucket: await hydrateBucket(bucket) });
}));

router.delete('/buckets/:id', asyncHandler(async (req, res) => {
  await detachWatcher(req.params.id);
  const result = await deleteBucket(req.params.id).catch(rethrowSharingError);
  res.json(result);
}));

router.post('/buckets/:id/export', asyncHandler(async (req, res) => {
  const body = validateRequest(sharingExportSchema, req.body || {});
  const result = await exportByKind({ ...body, bucketId: req.params.id }).catch(rethrowSharingError);
  res.json(result);
}));

router.get('/buckets/:id/inbox', asyncHandler(async (req, res) => {
  const items = await listInbox(req.params.id).catch(rethrowSharingError);
  res.json({ items });
}));

router.post('/buckets/:id/inbox/:manifestId/promote', asyncHandler(async (req, res) => {
  const result = await promoteInboxItem(req.params.id, req.params.manifestId).catch(rethrowSharingError);
  res.json(result);
}));

router.post('/buckets/:id/inbox/:manifestId/dismiss', asyncHandler(async (req, res) => {
  const result = await dismissInboxItem(req.params.id, req.params.manifestId).catch(rethrowSharingError);
  res.json(result);
}));

/**
 * Subscriptions — persistent (bucket, record) tuples for series + universe.
 * Subscribing kicks off the initial export; updates auto-re-export on
 * record change (debounced ~3s); unsubscribing removes the bucket-side file.
 */
router.get('/subscriptions', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.bucketId) filter.bucketId = String(req.query.bucketId);
  if (req.query.recordKind) filter.recordKind = String(req.query.recordKind);
  if (req.query.recordId) filter.recordId = String(req.query.recordId);
  const subscriptions = await listSubscriptions(filter);
  res.json({ subscriptions });
}));

router.post('/subscriptions', asyncHandler(async (req, res) => {
  const input = validateRequest(subscriptionCreateSchema, req.body || {});
  const sub = await subscribe(input).catch(rethrowSharingError);
  res.status(201).json({ subscription: sub });
}));

router.delete('/subscriptions/:id', asyncHandler(async (req, res) => {
  const result = await unsubscribe(req.params.id).catch(rethrowSharingError);
  res.json(result);
}));

/** Recent manifests (max 50, newest first) — both incoming and outgoing land here. */
router.get('/buckets/:id/activity', asyncHandler(async (req, res) => {
  const bucket = await getBucket(req.params.id).catch(rethrowSharingError);
  const filenames = (await listManifestFilenames(bucket.path)).slice(0, 50);
  const reads = await Promise.all(filenames.map(async (f) => {
    const m = await readManifest(bucket.path, f);
    return m ? { filename: f, ...m } : null;
  }));
  res.json({ manifests: reads.filter(Boolean) });
}));

export default router;
