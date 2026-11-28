/**
 * LLM-authored world structure: the stateless expand / generate-variations /
 * refine-prompts trio, plus the two per-universe bucket operations that
 * rearrange what those produced (promote-variation, auto-sort).
 *
 * The three stateless routes are static top-level paths — this router mounts
 * BEFORE crud.js so `/:id` can't swallow them.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import {
  expandSchema,
  promoteVariationSchema,
  autoSortSchema,
  generateVariationsSchema,
  refinePromptsSchema,
} from '../../lib/universeBuilderValidation.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { expandWorldTemplate, generateCategoryVariations } from '../../services/universeBuilderExpand.js';
import { refineWorldPrompts } from '../../services/universeBuilderRefine.js';
import { promoteVariationToCanon } from '../../services/universeBuilderPromote.js';
import { autoSortOtherBuckets } from '../../services/universeBuilderAutoSort.js';
import { mapServiceError } from './shared.js';

const router = Router();

// `expand` is a sub-resource — keep it ahead of `/:id` so the wildcard
// doesn't catch "expand" as a universe id.
router.post('/expand', asyncHandler(async (req, res) => {
  const body = validateRequest(expandSchema, req.body ?? {});
  const result = await expandWorldTemplate(body);
  res.json(result);
}));

router.post('/generate-variations', asyncHandler(async (req, res) => {
  const body = validateRequest(generateVariationsSchema, req.body ?? {});
  const result = await generateCategoryVariations(body);
  res.json(result);
}));

// Refines the 3 top-level prompts (starter / style / negative) based on
// user feedback. Stateless — the caller decides whether to write the
// result back to a saved universe. Keep ahead of `/:id`.
router.post('/refine-prompts', asyncHandler(async (req, res) => {
  const body = validateRequest(refinePromptsSchema, req.body ?? {});
  // Resolve the optional style-reference image to an absolute gallery path
  // before the service runs — fail loudly on a stale/bogus filename rather than
  // letting the runner silently drop it and refine text-only.
  let imagePath = null;
  if (body.image) {
    imagePath = resolveGalleryImage(body.image);
    if (!imagePath) {
      throw new ServerError(`Gallery image not found: ${body.image} — pick another and retry.`, { status: 400, code: 'GALLERY_IMAGE_NOT_FOUND' });
    }
  }
  res.json(await refineWorldPrompts({ ...body, imagePath }));
}));

// Promote a {label, prompt} variation into a full canon entry of the
// corresponding trunk (resolved from the bucket's `kind` field, or the
// caller-supplied `targetKind` for 'other'-kinded buckets). The variation
// is removed from its source bucket and the canon entry is appended in a
// single atomic patch.
router.post('/:id/promote-variation', asyncHandler(async (req, res) => {
  const body = validateRequest(promoteVariationSchema, req.body ?? {});
  const result = await promoteVariationToCanon(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Bulk-classify every `kind: 'other'` bucket via one LLM call. Each bucket's
// `kind` is updated atomically in one `updateUniverse` patch; renames the
// LLM suggests are surfaced in the response but not auto-applied (the UI
// can present them as opt-in suggestions).
router.post('/:id/auto-sort', asyncHandler(async (req, res) => {
  const body = validateRequest(autoSortSchema, req.body ?? {});
  const result = await autoSortOtherBuckets(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
