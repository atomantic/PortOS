/**
 * Art style references (#3109): the stateless analyze-then-review step plus
 * the add/remove delta endpoints.
 *
 * `/analyze-style-reference` is a static top-level path — this router mounts
 * BEFORE crud.js so `/:id` can't swallow it.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import * as svc from '../../services/universeBuilder.js';
import { analyzeUniverseStyleReference } from '../../services/universeStyleReference.js';
import {
  mapServiceError,
  entryIdField,
  lockedSchema,
  influencesSchema,
  styleReferenceSchema,
  resolveGalleryImageOrThrow,
} from './shared.js';

const router = Router();

const analyzeStyleReferenceSchema = z.object({
  image: z.string().trim().min(1).max(300),
  title: z.string().trim().max(svc.STYLE_REFERENCE_TITLE_MAX).optional(),
  prompt: z.string().trim().max(svc.STYLE_REFERENCE_PROMPT_MAX).optional(),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional().default(''),
  influences: influencesSchema.optional().default({ embrace: [], avoid: [] }),
  locked: lockedSchema.optional().default({}),
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
});

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

// Add/remove one reference at a time instead of PATCHing the whole array; see
// `addStyleReference` in services/universeBuilder/crud.js for the rationale.
// The wholesale-replace `{ styleReferences: [...] }` field on PATCH /:id stays
// accepted (older clients, peer imports, the sharing importer).
const addStyleReferenceSchema = z.object({
  // `id` is required here (unlike the wholesale-replace field, where the
  // sanitizer mints one): the id is what makes a re-sent add idempotent
  // server-side, and /analyze-style-reference always returns one. `required`
  // only drops the `.optional()` — the trim/length rules stay defined once, on
  // the shared `entryIdField`.
  reference: styleReferenceSchema.required({ id: true }),
  // Present when the user chose "Adopt style + add" — written in the SAME
  // queued write as the reference so the pair can't half-land. Both fields
  // default, so `adopt: {}` reads as "adopt an empty guide" (an explicit clear)
  // instead of reaching the service as `undefined` and clearing influences by
  // accident — matching analyzeStyleReferenceSchema's choice for the same pair.
  adopt: z.object({
    styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional().default(''),
    influences: influencesSchema.optional().default({ embrace: [], avoid: [] }),
  }).optional(),
});
router.post('/:id/style-references', asyncHandler(async (req, res) => {
  const body = validateRequest(addStyleReferenceSchema, req.body ?? {});
  const w = await svc.addStyleReference(req.params.id, body.reference, { adopt: body.adopt })
    .catch((err) => { throw mapServiceError(err); });
  res.json(w);
}));

// The id is only ever compared against stored reference ids (never used as a
// path/SQL operand), but validate it anyway so an absurdly long param is a 400
// here rather than a silent no-op deeper in.
const removeStyleReferenceParamsSchema = z.object({
  referenceId: entryIdField.unwrap(),
});
router.delete('/:id/style-references/:referenceId', asyncHandler(async (req, res) => {
  const { referenceId } = validateRequest(removeStyleReferenceParamsSchema, req.params);
  const w = await svc.removeStyleReference(req.params.id, referenceId)
    .catch((err) => { throw mapServiceError(err); });
  res.json(w);
}));

export default router;
