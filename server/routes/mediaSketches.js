/**
 *   GET    /api/media/sketches/:key
 *     → { key, sketch: { width, height, strokes, updatedAt, hasPng } | null }
 *   PUT    /api/media/sketches/:key
 *     body: { width, height, strokes: [...], png?: dataURL }
 *     → { key, sketch }  (sketch.strokes empty ⇒ sidecar removed)
 *   GET    /api/media/sketches/:key/png
 *     → flattened PNG bytes (image + strokes), 404 when none saved
 *
 * Key shape: `<kind>:<ref>` (only `image:*` may be annotated in phase 1).
 * Phase 1 of the Sketch & Annotation Canvas — issue #2036.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, mediaSketchSaveSchema } from '../lib/validation.js';
import * as svc from '../services/mediaSketches.js';

const router = Router();

const mapServiceError = (err) => {
  if (err?.code === svc.ERR_VALIDATION) {
    return new ServerError(err.message, { status: 400, code: err.code });
  }
  return err;
};

router.get('/:key', asyncHandler(async (req, res) => {
  const sketch = await svc.getSketch(req.params.key).catch((err) => { throw mapServiceError(err); });
  res.json({ key: req.params.key, sketch });
}));

router.get('/:key/png', asyncHandler(async (req, res) => {
  const png = await svc.getSketchPng(req.params.key).catch((err) => { throw mapServiceError(err); });
  if (!png) throw new ServerError('No sketch export for this media', { status: 404, code: 'NOT_FOUND' });
  res.type('image/png').send(png);
}));

router.put('/:key', asyncHandler(async (req, res) => {
  const body = validateRequest(mediaSketchSaveSchema, req.body ?? {});
  const sketch = await svc.saveSketch(req.params.key, body).catch((err) => { throw mapServiceError(err); });
  // Broadcast so other open views (History, Collections, other tabs) can drop a
  // stale "has annotation" badge or refresh without a manual reload.
  req.app.get('io')?.emit('media:sketch:updated', { key: req.params.key, sketch });
  res.json({ key: req.params.key, sketch });
}));

export default router;
