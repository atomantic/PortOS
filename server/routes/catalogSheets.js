/**
 * Catalog reference sheets: the sheet kinds a record's type offers, a preview
 * of exactly what a render would send, and the render itself.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { catalogSheetRenderSchema } from '../lib/catalogValidation.js';
import { getIngredient, listMediaForIngredient } from '../services/catalogDB.js';
import { listJobs } from '../services/mediaJobQueue/index.js';
import { resolveImageInputPath } from '../lib/pathSafety.js';
import { listCatalogSheetVariantsFor, previewCatalogSheet, removeCatalogPointerSheet, renderCatalogSheet } from '../services/catalogSheet.js';

const router = Router();

router.get('/ingredients/:id/sheets/variants', asyncHandler(async (req, res) => {
  const ingredient = await getIngredient(req.params.id);
  if (!ingredient) throw new ServerError('Ingredient not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ variants: await listCatalogSheetVariantsFor(ingredient) });
}));

// A bounded recovery view, not an export of worker params. Queue history survives
// navigation; files remain untouched until the user chooses to attach one.
router.get('/ingredients/:id/sheets/jobs', asyncHandler(async (req, res) => {
  const ingredient = await getIngredient(req.params.id);
  if (!ingredient) throw new ServerError('Ingredient not found', { status: 404, code: 'NOT_FOUND' });
  const media = await listMediaForIngredient(ingredient.id);
  const finishedAt = (job) => job.completedAt || job.startedAt || job.queuedAt || '';
  const jobs = listJobs({ kind: 'image' }).filter((job) => {
    const tag = job.params?.catalogAttach;
    if (tag?.ingredientId !== ingredient.id || typeof tag.role !== 'string' || !tag.role.startsWith('sheet:')
      || !['failed', 'canceled'].includes(job.status)) return false;
    // A recovered file or newer successful render already resolved this warning.
    const filename = job.params?.visualProfileSource?.filename || job.result?.filename;
    return !media.some((item) => !item.deleted && (item.mediaKey === filename
      || item.role === tag.role && item.createdAt >= finishedAt(job)));
  }).sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)));
  res.json({ jobs: jobs.slice(0, 20).map((job) => {
    const filename = job.params?.visualProfileSource?.filename || job.result?.filename;
    const savedFilename = typeof filename === 'string' && /^[^/\\]+\.(png|jpe?g|webp)$/i.test(filename)
      && resolveImageInputPath(filename) ? filename : null;
    return { jobId: job.id, status: job.status, error: job.error || null,
      role: job.params.catalogAttach.role, savedFilename };
  }), hasMore: jobs.length > 20 });
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
// any other media row). `variant` and the confirmed `filename` ride in the
// query string like the universe sheet DELETE.
const removePointerSheetQuerySchema = z.object({
  variant: z.string().trim().min(1).max(48).optional(),
  filename: z.string().trim().min(1).max(255).optional(),
});
router.delete('/ingredients/:id/sheets/pointer', asyncHandler(async (req, res) => {
  const options = validateRequest(removePointerSheetQuerySchema, req.query ?? {});
  res.json(await removeCatalogPointerSheet(req.params.id, options));
}));

export default router;
