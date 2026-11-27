/**
 * Art style references (#3109): the stateless analyze-then-review step plus
 * the add/remove delta endpoints.
 *
 * `/analyze-style-reference` is a static top-level path — this router mounts
 * BEFORE crud.js so `/:id` can't swallow it.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import {
  analyzeStyleReferenceSchema,
  addStyleReferenceSchema,
  adoptStyleSchema,
  removeStyleReferenceParamsSchema,
} from '../../lib/universeBuilderValidation.js';
import * as svc from '../../services/universeBuilder.js';
import { analyzeUniverseStyleReference } from '../../services/universeStyleReference.js';
import { mapServiceError, resolveGalleryImageOrThrow } from './shared.js';

const router = Router();

// Stateless review step: analyze the image and return a proposed record plus a
// diff. Persistence only happens after the user chooses reference-only or
// reference-and-adopt in the client.
router.post('/analyze-style-reference', asyncHandler(async (req, res) => {
  const body = validateRequest(analyzeStyleReferenceSchema, req.body ?? {});
  const { imageFilename, imagePath } = resolveGalleryImageOrThrow(body.image);
  res.json(await analyzeUniverseStyleReference({
    ...body,
    imagePath,
    imageFilename,
  }));
}));

router.post('/:id/style-references', asyncHandler(async (req, res) => {
  const body = validateRequest(addStyleReferenceSchema, req.body ?? {});
  const w = await svc.addStyleReference(req.params.id, body.reference, { adopt: body.adopt })
    .catch((err) => { throw mapServiceError(err); });
  res.json(w);
}));

router.post('/:id/adopt-style', asyncHandler(async (req, res) => {
  const body = validateRequest(adoptStyleSchema, req.body ?? {});
  const w = await svc.adoptStyleGuide(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(w);
}));

router.delete('/:id/style-references/:referenceId', asyncHandler(async (req, res) => {
  const { referenceId } = validateRequest(removeStyleReferenceParamsSchema, req.params);
  const w = await svc.removeStyleReference(req.params.id, referenceId)
    .catch((err) => { throw mapServiceError(err); });
  res.json(w);
}));

export default router;
