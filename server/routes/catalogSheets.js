/**
 * Catalog reference sheets: the sheet kinds a record's type offers, a preview
 * of exactly what a render would send, and the render itself.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { catalogSheetRenderSchema } from '../lib/catalogValidation.js';
import { getIngredient } from '../services/catalogDB.js';
import { listCatalogSheetVariantsFor, previewCatalogSheet, removeCatalogPointerSheet, renderCatalogSheet } from '../services/catalogSheet.js';

const router = Router();

router.get('/ingredients/:id/sheets/variants', asyncHandler(async (req, res) => {
  const ingredient = await getIngredient(req.params.id);
  if (!ingredient) throw new ServerError('Ingredient not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ variants: await listCatalogSheetVariantsFor(ingredient) });
}));

router.post('/ingredients/:id/sheets/preview', asyncHandler(async (req, res) => {
  const options = validateRequest(catalogSheetRenderSchema, req.body ?? {});
  res.json({ preview: await previewCatalogSheet(req.params.id, options) });
}));

router.post('/ingredients/:id/sheets', asyncHandler(async (req, res) => {
  const options = validateRequest(catalogSheetRenderSchema, req.body ?? {});
  res.json(await renderCatalogSheet(req.params.id, options));
}));

// Remove a universe-canon sheet pointer (the catalog-media sheets detach like
// any other media row). `variant` rides in the query string like the universe
// sheet DELETE.
const removePointerSheetQuerySchema = z.object({
  variant: z.string().trim().min(1).max(48).optional(),
});
router.delete('/ingredients/:id/sheets/pointer', asyncHandler(async (req, res) => {
  const options = validateRequest(removePointerSheetQuerySchema, req.query ?? {});
  res.json(await removeCatalogPointerSheet(req.params.id, options));
}));

export default router;
