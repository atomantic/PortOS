import { refuseRetiredTraining } from '../lib/retiredLoraTraining.js';
/** Read-only retired datasets and explicit cancellation of outstanding captions. */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';

import { listDatasets, reconcileRenderingImages } from '../services/loraDatasets.js';

import { attachCaptionSseClient, cancelCaptionRun, getActiveCaptionRun } from '../services/loraDatasetCaption.js';
import { LORA_DATASET_ENTRY_KINDS, computeDatasetReadiness } from '../lib/loraDataset.js';

const router = Router();
// Keep history/image reads and explicit caption cancellation available. Legacy
// clients cannot create, rewrite, render, caption, or delete training datasets.
router.use((req, _res, next) => {
  if (req.method !== 'GET' && !/^\/[^/]+\/caption-runs\/[^/]+\/cancel$/.test(req.path)) refuseRetiredTraining();
  next();
});

router.post('/:id/generate', refuseRetiredTraining);
router.post('/:id/caption', refuseRetiredTraining);
router.post('/:id/slice-reference-sheet', refuseRetiredTraining);

const idSchema = z.string().min(1).max(128);
const entryKindSchema = z.enum(LORA_DATASET_ENTRY_KINDS);

const listQuerySchema = z.object({
  universeId: idSchema.optional(),
  entryKind: entryKindSchema.optional(),
  entryId: idSchema.optional(),
  ingredientId: idSchema.optional(),
});
router.get('/', asyncHandler(async (req, res) => {
  const filters = validateRequest(listQuerySchema, req.query);
  const datasets = await listDatasets(filters);
  if (!isPaginationRequested(req.query)) return res.json(datasets);
  res.json(paginateArray(datasets, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  // Heal any images stuck in 'rendering' (server restart dropped the live
  // completion hook) before returning — the grid then shows truth.
  const dataset = await reconcileRenderingImages(req.params.id);
  // `captionRun` is the in-flight caption batch (or null) — how a reloaded page
  // or a second tab discovers, observes and cancels work the server is still doing.
  res.json({ ...dataset, readiness: computeDatasetReadiness(dataset), captionRun: getActiveCaptionRun(req.params.id) });
}));

router.get('/:id/caption-runs/:runId/events', asyncHandler(async (req, res) => {
  if (!attachCaptionSseClient(req.params.id, req.params.runId, res)) {
    throw new ServerError(`Caption run not found: ${req.params.runId}`, { status: 404, code: 'NOT_FOUND' });
  }
}));

// Run-scoped cancel: the id must match the dataset's CURRENT run, so a stale tab
// can't stop a newer batch. Returns the (now `canceling`) run projection; the
// terminal `canceled` frame follows over SSE once the run settles.
router.post('/:id/caption-runs/:runId/cancel', asyncHandler(async (req, res) => {
  res.status(202).json(cancelCaptionRun(req.params.id, req.params.runId));
}));

export default router;
