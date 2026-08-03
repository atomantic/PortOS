/**
 * Character reference sheets: the variant catalog plus render/delete of a
 * single character's sheet.
 *
 * `/reference-sheet-variants` is a static top-level path — this router mounts
 * BEFORE crud.js so `/:id` can't swallow it.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import {
  renderCharacterReferenceSheet,
  deleteCharacterReferenceSheet,
  listSheetVariants,
} from '../../services/universeCharacterSheet.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Static-path GETs must register BEFORE `/:id` so they aren't swallowed by
// the parametric route. The catalog lists every registered reference-sheet
// variant — the client renders one row per entry in CharacterReferenceSheetPanel.
router.get('/reference-sheet-variants', asyncHandler(async (_req, res) => {
  res.json({ variants: listSheetVariants() });
}));

// Generate one of the character reference-sheet variants from a structured
// TEXT prompt — no init image required, so it works across codex / local
// backends. The `variant` field selects which prompt-builder + storage slot
// the render targets (defaults to 'standard' = illustrated turnaround).
// Returns immediately with `{ jobId, generationId, variant }`; client
// subscribes to SSE for progress, and the server-side completion handler
// stamps the variant's pointer on success.
const renderReferenceSheetSchema = z.object({
  variant: z.string().trim().min(1).max(48).optional(),
  overridePrompt: z.string().trim().max(8000).optional(),
  overrideNegativePrompt: z.string().trim().max(2000).optional(),
  modelId: z.string().trim().max(64).optional(),
});
router.post('/:id/characters/:entryId/render-reference-sheet', asyncHandler(async (req, res) => {
  const options = validateRequest(renderReferenceSheetSchema, req.body ?? {});
  const result = await renderCharacterReferenceSheet(req.params.id, req.params.entryId, options)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Delete a character's reference sheet — unlinks the PNG from
// `data/image-refs/` and nulls the variant's pointer on every matching
// character so the UI clears reactively without a refetch. `variant` is
// passed via query string (DELETE bodies are awkward across HTTP clients).
const deleteReferenceSheetQuerySchema = z.object({
  variant: z.string().trim().min(1).max(48).optional(),
});
router.delete('/:id/characters/:entryId/reference-sheet', asyncHandler(async (req, res) => {
  const opts = validateRequest(deleteReferenceSheetQuerySchema, req.query ?? {});
  const result = await deleteCharacterReferenceSheet(req.params.id, req.params.entryId, opts)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
