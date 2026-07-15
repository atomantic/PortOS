/**
 *   POST   /api/media/sketches
 *     → { key: 'sketch:<uuid>' }  (mint a fresh blank-canvas sketch key)
 *   GET    /api/media/sketches/:key
 *     → { key, sketch: { width, height, strokes, updatedAt, hasPng } | null }
 *   PUT    /api/media/sketches/:key
 *     body: { width, height, strokes: [...], png?: dataURL }
 *     → { key, sketch }  (sketch.strokes empty ⇒ sidecar removed)
 *   GET    /api/media/sketches/:key/png
 *     → flattened PNG bytes (image + strokes), 404 when none saved
 *
 * Key shape: `image:<ref>` (annotate over a generated image, phases 1–2) or
 * `sketch:<uuid>` (a free-standing blank canvas, phase 3 — attachable to a
 * pipeline storyboard scene). Both are issue #2036.
 */

import { Router } from 'express';
import { asyncHandler, ServerError, createServiceErrorMapper } from '../lib/errorHandler.js';
import { validateRequest, mediaSketchSaveSchema } from '../lib/validation.js';
import * as svc from '../services/mediaSketches.js';

const router = Router();

const mapServiceError = createServiceErrorMapper({ [svc.ERR_VALIDATION]: 400 });

// Mint a blank-canvas sketch key. The client can't rely on crypto.randomUUID
// (PortOS is served over plain HTTP on Tailscale, an insecure origin), so the
// server owns id generation.
router.post('/', asyncHandler(async (_req, res) => {
  res.status(201).json({ key: svc.createBlankSketchKey() });
}));

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
