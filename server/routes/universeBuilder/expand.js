/**
 * LLM-authored world structure: the stateless expand / generate-variations /
 * refine-prompts trio, plus the two per-universe bucket operations that
 * rearrange what those produced (promote-variation, auto-sort).
 *
 * The three stateless routes are static top-level paths — this router mounts
 * BEFORE crud.js so `/:id` can't swallow them.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import * as svc from '../../services/universeBuilder.js';
import { expandWorldTemplate, generateCategoryVariations } from '../../services/universeBuilderExpand.js';
import { refineWorldPrompts } from '../../services/universeBuilderRefine.js';
import { promoteVariationToCanon, VALID_TARGET_KINDS } from '../../services/universeBuilderPromote.js';
import { autoSortOtherBuckets } from '../../services/universeBuilderAutoSort.js';
import {
  mapServiceError,
  variationSchema,
  compositeSheetSchema,
  categoriesSchema,
  lockedSchema,
  influencesSchema,
} from './shared.js';

const router = Router();

const expandSchema = z.object({
  starterPrompt: z.string().trim().min(1).max(svc.STARTER_PROMPT_MAX),
  // Optional structured influences from a prior refinement — passed in so
  // the LLM keeps re-expansions on-direction instead of regenerating from
  // the bare starter idea.
  influences: influencesSchema.optional(),
  // Per-item locks the user has set on individual variations / composite
  // boards. Listed in the LLM prompt so it doesn't waste tokens regenerating
  // them; the client merges them back in after the result returns.
  preservedVariations: z.record(
    z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX),
    z.array(variationSchema).max(svc.VARIATIONS_PER_CATEGORY_MAX),
  ).optional(),
  preservedCompositeSheets: z.array(compositeSheetSchema).max(svc.COMPOSITE_SHEETS_MAX).optional(),
  // Current bible/prompt state — locked entries are echoed verbatim, others
  // are starting points the LLM can refine while staying consistent.
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional(),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional(),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional(),
  locked: lockedSchema.optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// `targetKind` is only required when the source bucket's `kind` is 'other'
// (otherwise the service resolves it from the bucket). Enum derived from
// VALID_TARGET_KINDS so the schema and the resolver share one source.
const promoteVariationSchema = z.object({
  category: z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX),
  label: z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX),
  targetKind: z.enum(VALID_TARGET_KINDS).optional(),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

// Auto-sort takes no bucket selection — the service scans for every
// `kind: 'other'` bucket on the universe. Provider/model are optional;
// the service falls back to the active provider when omitted.
const autoSortSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

const generateVariationsSchema = z.object({
  category: z.string().trim().min(1).max(svc.WORLD_CATEGORY_KEY_MAX),
  count: z.number().int().min(1).max(svc.VARIATIONS_PER_CATEGORY_MAX),
  existingLabels: z.array(z.string().trim().min(1).max(svc.VARIATION_LABEL_MAX))
    .max(svc.VARIATIONS_PER_CATEGORY_MAX).optional().default([]),
  influences: influencesSchema.optional(),
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional().default(''),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

const refinePromptsSchema = z.object({
  starterPrompt: z.string().trim().min(1).max(svc.STARTER_PROMPT_MAX),
  // Bible context: passed in so the refiner sees the full seed, refines them
  // alongside the prompts, and stays consistent with the universe's narrative.
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional().default(''),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional().default(''),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional().default(''),
  // Structured influences (embrace + avoid) — refined alongside the prompts
  // and used as the canonical reference list for renderer-token composition.
  influences: influencesSchema.optional(),
  // Post-Expand structure — when present, the refiner sees the full universe
  // (categories + composites with per-item locks) and may edit/replace/add
  // items per the user's feedback. When omitted (pre-Expand iteration), the
  // refiner falls back to the bible-only behavior.
  categories: categoriesSchema.optional(),
  compositeSheets: z.array(compositeSheetSchema).max(svc.COMPOSITE_SHEETS_MAX).optional(),
  // Per-field lock map — locked fields are echoed back unchanged regardless
  // of what the LLM tries to write.
  locked: lockedSchema.optional().default({}),
  feedback: z.string().trim().min(1).max(3000),
  // Optional gallery image used as a VISUAL style reference — when present the
  // refiner forces a vision-capable API provider and folds the image's
  // palette/lighting/mood into influences + styleNotes. Resolved to an absolute
  // path in the handler before reaching the service.
  image: z.string().trim().min(1).max(300).optional(),
  providerId: z.string().trim().max(80).optional(),
  // Whitespace-only model → undefined so the refiner's defaultModel /
  // models[0] fallback kicks in instead of a blank string reaching the
  // provider. Mirrors how /api/media-jobs/refine-prompt handles it.
  model: z.string().max(200).optional().transform((s) => {
    const v = (s ?? '').trim();
    return v.length > 0 ? v : undefined;
  }),
});

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
