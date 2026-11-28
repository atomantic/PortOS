/**
 * Vision-driven description of canon entries: describe-from-images (blind
 * prose from reference images), expand-from-images (fill still-blank
 * structured fields), and the corrective correct-from-image →
 * apply-image-correction review pair.
 *
 * `/describe-from-images` is a static top-level path — this router mounts
 * BEFORE crud.js so `/:id` can't swallow it.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import {
  lockParamsSchema,
  describeFromImagesSchema,
  expandFromImagesSchema,
  correctFromImageSchema,
  applyImageCorrectionSchema,
} from '../../lib/universeBuilderValidation.js';
import * as canonSvc from '../../services/universeCanon.js';
import { describeEntityFromImages, correctEntityFromImage } from '../../services/universeVisionDescribe.js';
import { expandEntityFromImages } from '../../services/universeVisionExpand.js';
import { mapServiceError, resolveImageSources, resolveGalleryImageOrThrow } from './shared.js';

const router = Router();

// Vision-to-prose: turn one or more reference images of a character/place/
// object into an image-gen-ready prose description (multiple images → the
// shared/common description). Stateless — the client decides which entry
// field to write the result into. Images come from upload OR the gallery (see
// resolveImageSources). Keep ahead of `/:id` so "describe-from-images" isn't
// parsed as a universe id.
router.post('/describe-from-images', asyncHandler(async (req, res) => {
  const body = validateRequest(describeFromImagesSchema, req.body ?? {});
  const screenshots = resolveImageSources(body.images);
  const result = await describeEntityFromImages({ ...body, screenshots });
  res.json(result);
}));

// Vision-driven expand — a vision model reads reference image(s) (upload or
// gallery) and PROPOSES values for the character's still-blank structured
// fields (palette/visual notes/expressions/...). Review-only: returns the
// proposed `{ field: value }` map; the client applies the kept/edited values
// via the normal entry-PATCH path. No-clobber, characters-only, locked
// characters return `{ locked: true }` with no LLM call.
router.post('/:id/characters/:entryId/expand-from-images', asyncHandler(async (req, res) => {
  const body = validateRequest(expandFromImagesSchema, req.body ?? {});
  const screenshots = resolveImageSources(body.images);
  const result = await expandEntityFromImages({
    universeId: req.params.id,
    entryId: req.params.entryId,
    name: body.name,
    context: body.context,
    screenshots,
    providerId: body.providerId,
    model: body.model,
  }).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Corrective vision analysis for ONE canon entry (character/place/object):
// given the entry's CURRENT descriptor text as context, a vision model
// proposes a CORRECTED replacement — unlike expand-from-images (fills only
// still-blank fields) or describe-from-images (describes blind), this
// overwrites existing text where the image contradicts it. Review-only:
// returns the proposed text for the client to show alongside the current
// value; `apply-image-correction` (below) persists it.
router.post('/:id/canon/:kind/:entryId/correct-from-image', asyncHandler(async (req, res) => {
  const { kind } = validateRequest(lockParamsSchema, req.params);
  const body = validateRequest(correctFromImageSchema, req.body ?? {});
  const { imageFilename, imagePath } = resolveGalleryImageOrThrow(body.image);
  const result = await correctEntityFromImage({
    universeId: req.params.id,
    entryId: req.params.entryId,
    kind,
    name: body.name,
    context: body.context,
    screenshot: imagePath,
    providerId: body.providerId,
    model: body.model,
  }).catch((err) => { throw mapServiceError(err); });
  res.json({ ...result, imageFilename });
}));

// Persist a reviewed corrective-image analysis: overwrites the entry's
// descriptor field with the reviewed text AND pins the analyzed image as the
// entry's `primaryImageRef` — assigning it as that noun's style/reference
// image so subsequent renders (client-side i2i seeding) use it.
router.post('/:id/canon/:kind/:entryId/apply-image-correction', asyncHandler(async (req, res) => {
  const { kind } = validateRequest(lockParamsSchema, req.params);
  const body = validateRequest(applyImageCorrectionSchema, req.body ?? {});
  const result = await canonSvc.applyCanonImageCorrection(req.params.id, kind, req.params.entryId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
