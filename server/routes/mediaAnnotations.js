/**
 *   GET    /api/media/annotations
 *     Optional kind and up to 100 keys (repeat keys for each value). Both filters apply when supplied.
 *     → { annotations: { [key]: { own: { authorName, starred, note, updatedAt } | null,
 *                                  others: [{ instanceId, authorName, starred, note, updatedAt }] } } }
 *   PATCH  /api/media/annotations/:key
 *     body: { starred?: boolean, rating?: 'good' | 'bad' | null, note?: string } — writes the local-author entry
 *     → { key, entry: { own, others } }
 *
 * Key shape: `<kind>:<ref>` where kind ∈ {image, video, image-ref} and ref has
 * no `:`. image/video match mediaCollections.js and normalize.js (`item.key`);
 * image-ref is a /data/image-refs file (see mediaAnnotationKey on the client).
 */

import { patchSchema } from '../lib/mediaAnnotationsValidation.js';
import { emitToOperatorsOn } from '../services/socketIo.js';
import { Router } from 'express';
import { asyncHandler, createServiceErrorMapper } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { mediaAnnotationsQuerySchema } from '../lib/mediaValidation.js';
import * as svc from '../services/mediaAnnotations.js';

const router = Router();

const SERVICE_ERROR_STATUS = {
  [svc.ERR_VALIDATION]: 400,
};

const mapServiceError = createServiceErrorMapper(SERVICE_ERROR_STATUS);

router.get('/', asyncHandler(async (req, res) => {
  const query = validateRequest(mediaAnnotationsQuerySchema, req.query);
  res.json({ annotations: await svc.listAnnotations(query) });
}));

router.patch('/:key', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  // Express decodes the path param, but the key still has to round-trip through
  // svc validation so a hand-rolled curl can't sneak past.
  const entry = await svc.setAnnotation(req.params.key, body).catch((err) => { throw mapServiceError(err); });
  // Broadcast so every other open view (History, Collections, Pipeline, other
  // browser tabs) reflects the change without a manual refresh. Payload mirrors
  // the GET shape: `entry` is `{ own, others }` (with own=null when the local
  // author cleared their entry but peer notes remain).
  emitToOperatorsOn(req.app.get('io'), 'media:annotation:updated', { key: req.params.key, entry });
  res.json({ key: req.params.key, entry });
}));

export default router;
