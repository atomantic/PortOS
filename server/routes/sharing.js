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
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  bucketCreateSchema, bucketUpdateSchema, sharingExportSchema,
} from '../lib/validation.js';
import {
  listBuckets, getBucket, createBucket, updateBucket, deleteBucket,
} from '../services/sharing/buckets.js';
import { attachWatcher, detachWatcher } from '../services/sharing/watcher.js';
import { exportByKind } from '../services/sharing/exporter.js';
import {
  listInbox, promoteInboxItem, dismissInboxItem,
} from '../services/sharing/importer.js';
import { listManifestFilenames, readManifest } from '../services/sharing/manifest.js';

const router = Router();

router.get('/buckets', asyncHandler(async (req, res) => {
  const buckets = await listBuckets();
  res.json({ buckets });
}));

router.get('/buckets/:id', asyncHandler(async (req, res) => {
  const bucket = await getBucket(req.params.id);
  res.json({ bucket });
}));

router.post('/buckets', asyncHandler(async (req, res) => {
  const input = validateRequest(bucketCreateSchema, req.body || {});
  const bucket = await createBucket(input);
  await attachWatcher(bucket.id);
  res.status(201).json({ bucket });
}));

router.put('/buckets/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(bucketUpdateSchema, req.body || {});
  const bucket = await updateBucket(req.params.id, patch);
  res.json({ bucket });
}));

router.delete('/buckets/:id', asyncHandler(async (req, res) => {
  await detachWatcher(req.params.id);
  const result = await deleteBucket(req.params.id);
  res.json(result);
}));

router.post('/buckets/:id/export', asyncHandler(async (req, res) => {
  const body = validateRequest(sharingExportSchema, req.body || {});
  const result = await exportByKind({ ...body, bucketId: req.params.id });
  res.json(result);
}));

router.get('/buckets/:id/inbox', asyncHandler(async (req, res) => {
  const items = await listInbox(req.params.id);
  res.json({ items });
}));

router.post('/buckets/:id/inbox/:manifestId/promote', asyncHandler(async (req, res) => {
  const result = await promoteInboxItem(req.params.id, req.params.manifestId);
  res.json(result);
}));

router.post('/buckets/:id/inbox/:manifestId/dismiss', asyncHandler(async (req, res) => {
  const result = await dismissInboxItem(req.params.id, req.params.manifestId);
  res.json(result);
}));

/** Recent manifests (max 50, newest first) — both incoming and outgoing land here. */
router.get('/buckets/:id/activity', asyncHandler(async (req, res) => {
  const bucket = await getBucket(req.params.id);
  const filenames = (await listManifestFilenames(bucket.path)).slice(0, 50);
  const reads = await Promise.all(filenames.map(async (f) => {
    const m = await readManifest(bucket.path, f);
    return m ? { filename: f, ...m } : null;
  }));
  res.json({ manifests: reads.filter(Boolean) });
}));

export default router;
