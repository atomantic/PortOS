/**
 *   GET    /api/media/collections                  → Collection[]       (`?limit`/`?offset` switch it to
 *                                                                       `{ items, total, limit, offset }`)
 *   POST   /api/media/collections                  → Collection         (body: { name, description? })
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

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError, createServiceErrorMapper } from '../lib/errorHandler.js';
import { validateRequest, mediaCollectionBulkItemsSchema, isPaginationRequested, paginateArray } from '../lib/validation.js';
import * as svc from '../services/mediaCollections.js';
import { resolveMediaLocations, unmarkHosted } from '../services/peerHostedMedia.js';
import { pullMissingAssetsFromPeer, collectionVideoRefToFilename } from '../services/sharing/peerSyncAssets.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_DUPLICATE]: 409,
  [svc.ERR_VALIDATION]: 400,
};

const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS);

const nameSchema = z.string().trim().min(1).max(svc.NAME_MAX_LENGTH);
const descriptionSchema = z.string().trim().max(svc.DESCRIPTION_MAX_LENGTH);
// `:` is the API key separator (`<kind>:<ref>` is split on first `:`), so a
// ref containing one would be unaddressable for DELETE/coverKey lookups.
const refSchema = z.string().trim().min(1).max(svc.REF_MAX_LENGTH).refine((s) => !s.includes(':'), { message: 'ref may not contain ":"' });
const kindSchema = z.enum(['image', 'video']);

const createSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.optional().default(''),
});

const patchSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  // coverKey: null clears it (auto = newest); a string pins a specific item.
  coverKey: z.union([z.string().trim().min(1).max(svc.REF_MAX_LENGTH + 8), z.null()]).optional(),
  // Provenance override (#3311) — lets the user correct a collection the
  // migration's marker classification stamped wrong. Deliberately absent from
  // `createSchema`: a POST is a person creating a collection, which the service
  // stamps 'user' on its own, so accepting the field there would only let a
  // client mislabel its own new collection.
  source: z.enum(svc.COLLECTION_SOURCES).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const itemSchema = z.object({
  kind: kindSchema,
  ref: refSchema,
});

// Backward-compatible by default: returns the full collections array. When a
// client passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const list = await svc.listCollections();
  if (!isPaginationRequested(req.query)) return res.json(list);
  res.json(paginateArray(list, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await svc.createCollection(body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const c = await svc.getCollection(req.params.id).catch((err) => { throw mapServiceError(err); });
  const locations = await resolveMediaLocations(c.items);
  res.json({ ...c, items: c.items.map((item, i) => ({ ...item, ...locations[i] })) });
}));

const localizeSchema = z.object({ keys: z.array(z.string().min(1).max(svc.REF_MAX_LENGTH + 8)).max(svc.ITEMS_MAX).optional() });

// Copy peer-hosted items onto this machine. Pulls run in the background (a video
// can be large); each landed file emits `peerSync:asset-arrived`, which the
// collection page listens for, so there is nothing to poll.
router.post('/:id/localize', asyncHandler(async (req, res) => {
  const { keys } = validateRequest(localizeSchema, req.body ?? {});
  const c = await svc.getCollection(req.params.id).catch((err) => { throw mapServiceError(err); });
  const wanted = keys ? new Set(keys) : null;
  const items = c.items.filter((item) => !wanted || wanted.has(svc.itemKey(item)));
  const locations = await resolveMediaLocations(items);
  const byPeer = new Map();
  items.forEach((item, i) => {
    if (locations[i].location !== 'remote') return;
    const filename = item.kind === 'video' ? collectionVideoRefToFilename(item.ref) : item.ref;
    const list = byPeer.get(locations[i].hostPeerId) ?? [];
    list.push({ kind: item.kind, filename });
    byPeer.set(locations[i].hostPeerId, list);
  });
  const started = [...byPeer.values()].reduce((n, list) => n + list.length, 0);
  Promise.all([...byPeer.entries()].map(async ([peerId, list]) => {
    await pullMissingAssetsFromPeer(peerId, list, { includeMismatched: false });
    await Promise.all(list.map((entry) => unmarkHosted(entry.kind, entry.filename)));
  })).catch((err) => console.error(`❌ localize collection media failed: ${err.message}`));
  res.status(202).json({ requested: items.length, started });
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
