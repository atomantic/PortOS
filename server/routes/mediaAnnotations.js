/**
 *   GET    /api/media/annotations          → { [key]: { starred, note, updatedAt } }
 *   PATCH  /api/media/annotations/:key     → updated entry or null (if pruned)
 *                                            body: { starred?: boolean, note?: string }
 *
 * Key shape: `<kind>:<ref>` where kind ∈ {image, video} and ref has no `:`.
 * Matches the convention enforced by mediaCollections.js and produced by the
 * client-side normalize.js (`item.key`).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as svc from '../services/mediaAnnotations.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_VALIDATION]: 400,
};

const mapServiceError = (err) => {
  const status = SERVICE_ERROR_STATUS[err?.code];
  if (status) return new ServerError(err.message, { status, code: err.code });
  return err;
};

const patchSchema = z.object({
  starred: z.boolean().optional(),
  note: z.string().max(svc.NOTE_MAX_LENGTH).optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include starred and/or note' });

router.get('/', asyncHandler(async (_req, res) => {
  res.json({ annotations: await svc.listAnnotations() });
}));

router.patch('/:key', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  // Express decodes the path param, but the key still has to round-trip through
  // svc validation so a hand-rolled curl can't sneak past.
  const updated = await svc.setAnnotation(req.params.key, body).catch((err) => { throw mapServiceError(err); });
  // Broadcast so every other open view (History, Collections, Pipeline, other
  // browser tabs) reflects the change without a manual refresh. `entry` is null
  // when the annotation was pruned (both starred=false and note='').
  req.app.get('io')?.emit('media:annotation:updated', { key: req.params.key, entry: updated });
  res.json({ key: req.params.key, entry: updated });
}));

export default router;
