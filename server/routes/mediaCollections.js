/**
 *   GET    /api/media/collections                  → Collection[]       (`?limit`/`?offset` switch it to
 *                                                                       `{ items, total, limit, offset }`)
 *   POST   /api/media/collections                  → Collection         (body: { name, description? })
 *   POST   /api/media/collections/join             → Collection & { removedCollectionIds, keptCollectionIds }
 *                                                  (body: { name, collectionIds, keepOriginals? }; merges into the
 *                                                  selected collection already named `name`, else a new one, and
 *                                                  retires the other non-owner-managed sources)
 *   GET    /api/media/collections/:id              → Collection
 *                                                  Each item carries `location` ('local' | 'remote' | 'missing')
 *                                                  and, when remote, `hostPeerId`/`hostPeerName` (peer-hosted media)
 *   POST   /api/media/collections/:id/localize     → { requested, started }  (body: { keys?: ["<kind>:<ref>"] };
 *                                                                       copies peer-hosted items onto this machine)
 *   PATCH  /api/media/collections/:id              → Collection         (body: { name?, description?, coverKey?, source? })
 *   DELETE /api/media/collections/:id              → { id }
 *   POST   /api/media/collections/:id/items        → Collection         (body: { kind, ref })
 *   POST   /api/media/collections/:id/items/bulk   → { collection, added, removed }
 *                                                                       (body: { add?: [{kind,ref}], remove?: ["<kind>:<ref>"] })
 *   DELETE /api/media/collections/:id/items/:key   → Collection         (key = "<kind>:<ref>")
 */

import { createSchema, patchSchema, itemSchema, localizeSchema } from '../lib/mediaCollectionsValidation.js';
import { Router } from 'express';
import { assertCancelResult } from '../lib/cancelResponse.js';
import { cancelOperationSchema } from '../lib/sharedSchemas.js';
import { emptyQuerySchema, paginationQuerySchema, isPaginationRequested, paginateArray } from '../lib/queryValidation.js';
import { asyncHandler, ServerError, createServiceErrorMapper } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { mediaCollectionBulkItemsSchema, mediaCollectionJoinSchema, mediaCollectionPrimarySchema } from '../lib/mediaValidation.js';
import * as svc from '../services/mediaCollections.js';
import { resolveMediaLocations, unmarkHosted, findHostPeer } from '../services/peerHostedMedia.js';
import { pullMissingAssetsFromPeer } from '../services/sharing/peerSyncAssets.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_DUPLICATE]: 409,
  [svc.ERR_VALIDATION]: 400,
  [svc.ERR_INCOMPLETE_INVENTORY]: 503,
};

const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS);

const joinSchema = mediaCollectionJoinSchema(svc.NAME_MAX_LENGTH);

// Backward-compatible by default: returns the full collections array. When a
// client passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(paginationQuerySchema, req.query);
  const list = await svc.listCollections();
  if (!isPaginationRequested(query)) return res.json(list);
  res.json(paginateArray(list, query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await svc.createCollection(body));
}));

router.post('/join', asyncHandler(async (req, res) => {
  const body = validateRequest(joinSchema, req.body ?? {});
  const collection = await svc.joinCollections(body).catch((err) => { throw mapServiceError(err); });
  res.status(201).json(collection);
}));

router.post('/auto-organize', asyncHandler(async (_req, res) => {
  const { autoOrganizeMediaCollections } = await import('../services/mediaCollectionAutoOrganize.js');
  res.json(await autoOrganizeMediaCollections());
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const c = await svc.getCollection(req.params.id).catch((err) => { throw mapServiceError(err); });
  const locations = await resolveMediaLocations(c.items);
  res.json({ ...c, items: c.items.map((item, i) => ({ ...item, ...locations[i] })) });
}));

// Copy peer-hosted items onto this machine. Pulls run in the background (a video
// can be large); each landed file emits `peerSync:asset-arrived`, which the
// collection page listens for, so there is nothing to poll.
router.post('/:id/localize', asyncHandler(async (req, res) => {
  const { keys } = validateRequest(localizeSchema, req.body ?? {});
  const c = await svc.getCollection(req.params.id).catch((err) => { throw mapServiceError(err); });
  const wanted = keys ? new Set(keys) : null;
  const items = c.items.filter((item) => !wanted || wanted.has(svc.itemKey(item)));
  const locations = await resolveMediaLocations(items, { includeFilename: true });
  const byPeer = new Map();
  items.forEach((item, i) => {
    if (locations[i].location !== 'remote') return;
    const { filename } = locations[i];
    const list = byPeer.get(locations[i].hostPeerId) ?? [];
    list.push({ kind: item.kind, filename });
    byPeer.set(locations[i].hostPeerId, list);
  });
  const started = [...byPeer.values()].reduce((n, list) => n + list.length, 0);
  Promise.all([...byPeer.entries()].map(async ([peerId, list]) => {
    if (!await findHostPeer(peerId)) return; // disabled or removed peer: nothing to pull from
    await pullMissingAssetsFromPeer(peerId, list, { includeMismatched: false });
    await Promise.all(list.map((entry) => unmarkHosted(entry.kind, entry.filename)));
  })).catch((err) => console.error(`❌ localize collection media failed: ${err.message}`));
  res.status(202).json({ requested: items.length, started });
}));

router.get('/:id/primary', asyncHandler(async (req, res) => {
  const { getCollectionPrimaryStatus } = await import('../services/mediaCollectionPrimary.js');
  res.set('Cache-Control', 'no-store').json(await getCollectionPrimaryStatus(req.params.id).catch((err) => { throw mapServiceError(err); }));
}));

router.post('/:id/primary', asyncHandler(async (req, res) => {
  const { instanceId } = validateRequest(mediaCollectionPrimarySchema, req.body ?? {});
  const { startCollectionPrimary } = await import('../services/mediaCollectionPrimary.js');
  res.status(202).json(await startCollectionPrimary(req.params.id, instanceId)
    .catch((err) => { throw mapServiceError(err); }));
}));

router.post('/:id/primary/cancel', asyncHandler(async (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  const { runId } = validateRequest(cancelOperationSchema, req.body ?? {});
  const { cancelCollectionPrimary } = await import('../services/mediaCollectionPrimary.js');
  res.status(202).json(assertCancelResult(cancelCollectionPrimary(req.params.id, runId), { notFoundMessage: 'Active consolidation run not found' }));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  const c = await svc.updateCollection(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.json(c);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const r = await svc.deleteCollection(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

router.post('/:id/items', asyncHandler(async (req, res) => {
  const body = validateRequest(itemSchema, req.body ?? {});
  const c = await svc.addItem(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  res.json(c);
}));

// Bulk add+remove in a single read-modify-write. Returns
// `{ collection, added, removed }` so callers can show "Added 3, removed 12"
// confirmations without re-deriving the diff client-side.
router.post('/:id/items/bulk', asyncHandler(async (req, res) => {
  const body = validateRequest(mediaCollectionBulkItemsSchema, req.body ?? {});
  const result = await svc.bulkUpdateCollectionItems(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.delete('/:id/items/:key', asyncHandler(async (req, res) => {
  // The :key route param is "<kind>:<ref>" — Express decodes it for us, but
  // we still validate the shape so a hand-rolled curl can't sneak past the
  // service-layer check.
  const key = req.params.key || '';
  const idx = key.indexOf(':');
  if (idx <= 0) throw new ServerError('Invalid item key', { status: 400, code: 'VALIDATION_ERROR' });
  const kind = key.slice(0, idx);
  const ref = key.slice(idx + 1);
  validateRequest(itemSchema, { kind, ref });
  const c = await svc.removeItem(req.params.id, key).catch((err) => { throw mapServiceError(err); });
  res.json(c);
}));

export default router;
