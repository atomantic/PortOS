/**
 *   GET    /api/media/collections                  → Collection[]
 *   POST   /api/media/collections                  → Collection         (body: { name, description? })
 *   GET    /api/media/collections/:id              → Collection
 *   PATCH  /api/media/collections/:id              → Collection         (body: { name?, description?, coverKey? })
 *   DELETE /api/media/collections/:id              → { id }
 *   POST   /api/media/collections/:id/items        → Collection         (body: { kind, ref })
 *   DELETE /api/media/collections/:id/items/:key   → Collection         (key = "<kind>:<ref>")
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as svc from '../services/mediaCollections.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_NOT_FOUND]: 404,
  [svc.ERR_DUPLICATE]: 409,
  [svc.ERR_VALIDATION]: 400,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

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
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const itemSchema = z.object({
  kind: kindSchema,
  ref: refSchema,
});

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await svc.listCollections());
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await svc.createCollection(body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const c = await svc.getCollection(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(c);
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
