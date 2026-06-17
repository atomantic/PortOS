/**
 * LoRA training dataset routes — `/api/lora-datasets`.
 *
 * CRUD + image upload (multipart) + batch generation + reference-sheet
 * slicing + vision captioning (SSE) for the per-subject training
 * datasets behind /media/training. Training-run launch lives at
 * `/api/lora-training` (routes/loraTraining.js); this surface ends at
 * "dataset ready to train".
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { uploadFields } from '../lib/multipart.js';
import {
  addUploadedImage,
  createDataset,
  deleteDataset,
  deleteImage,
  getDataset,
  importGalleryImages,
  listDatasets,
  patchDataset,
  reconcileRenderingImages,
  stripSharedCaptionFragments,
  updateImageCaption,
} from '../services/loraDatasets.js';
import { generateDatasetImages, getDatasetVariationAxes, sliceReferenceSheet } from '../services/loraDatasetGenerate.js';
import { attachCaptionSseClient, startCaptionRun } from '../services/loraDatasetCaption.js';
import { LORA_DATASET_ENTRY_KINDS, computeDatasetReadiness } from '../lib/loraDataset.js';

const router = Router();

const triggerWordSchema = z.string().regex(/^[a-z0-9_]{2,64}$/, 'trigger word must be 2-64 chars of [a-z0-9_]');
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
  res.json(await listDatasets(filters));
}));

const createSchema = z.object({
  universeId: idSchema,
  entryKind: entryKindSchema.default('characters'),
  entryId: idSchema,
  triggerWord: triggerWordSchema.optional(),
});
router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body);
  const { dataset, created } = await createDataset(body);
  res.status(created ? 201 : 200).json(dataset);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  // Heal any images stuck in 'rendering' (server restart dropped the live
  // completion hook) before returning — the grid then shows truth.
  const dataset = await reconcileRenderingImages(req.params.id);
  res.json({ ...dataset, readiness: computeDatasetReadiness(dataset) });
}));

// Live variation axes (expressions/outfits for characters; lighting/settings
// for objects & places) so the generate-batch dialog seeds its override chips
// from the server vocab instead of duplicating the object/place axis constants.
router.get('/:id/variation-axes', asyncHandler(async (req, res) => {
  res.json(await getDatasetVariationAxes(req.params.id));
}));

const patchSchema = z.object({
  triggerWord: triggerWordSchema.optional(),
  // Reassign the dataset to a different universe subject. Universe + entry id
  // must be present together; the service re-snapshots the subject and refuses
  // a collision with an existing dataset for that subject.
  universeId: idSchema.optional(),
  entryKind: entryKindSchema.optional(),
  entryId: idSchema.optional(),
});
router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body);
  const dataset = await patchDataset(req.params.id, body);
  res.json({ ...dataset, readiness: computeDatasetReadiness(dataset) });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await deleteDataset(req.params.id));
}));

// Image upload — up to 10 files per request on image1…image10 field names.
const UPLOAD_FIELDS = Array.from({ length: 10 }, (_, i) => `image${i + 1}`);
const ACCEPTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const datasetUploads = uploadFields(UPLOAD_FIELDS, {
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => cb(null, ACCEPTED_MIME.has((file.mimetype || '').toLowerCase())),
});
router.post('/:id/images', datasetUploads, asyncHandler(async (req, res) => {
  const staged = Object.values(req.files || {});
  if (!staged.length) {
    throw new ServerError('No image files in request (use field names image1…image10)', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  const entries = [];
  for (const file of staged) {
    entries.push(await addUploadedImage(req.params.id, {
      tmpPath: file.path, originalname: file.originalname,
    }));
  }
  res.status(201).json({ images: entries });
}));

// Import existing gallery images into the dataset by basename. The server
// re-normalizes each through sharp (gallery PNGs are `<jobId>.png`).
const importGallerySchema = z.object({
  filenames: z.array(z.string().max(256).regex(/^[^/\\]+\.png$/i, 'filename must be a gallery PNG basename')).min(1).max(50),
});
router.post('/:id/import-gallery', asyncHandler(async (req, res) => {
  const { filenames } = validateRequest(importGallerySchema, req.body);
  const images = await importGalleryImages(req.params.id, { filenames });
  res.status(201).json({ images });
}));

const generateSchema = z.object({
  count: z.number().int().min(1).max(40).default(12),
  views: z.array(z.string().max(120)).max(12).optional(),
  poses: z.array(z.string().max(120)).max(12).optional(),
  expressions: z.array(z.string().max(120)).max(12).optional(),
  outfits: z.array(z.string().max(120)).max(12).optional(),
  modelId: z.string().max(128).optional(),
});
router.post('/:id/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(generateSchema, req.body);
  res.status(202).json(await generateDatasetImages(req.params.id, body));
}));

const sliceSchema = z.object({
  variant: z.string().max(64).default('standard'),
  cols: z.number().int().min(1).max(6).default(3),
  rows: z.number().int().min(1).max(6).default(2),
});
router.post('/:id/slice-reference-sheet', asyncHandler(async (req, res) => {
  const body = validateRequest(sliceSchema, req.body);
  res.status(201).json(await sliceReferenceSheet(req.params.id, body));
}));

const captionSchema = z.object({
  imageIds: z.array(idSchema).max(200).optional(),
  providerId: z.string().max(128).optional(),
  model: z.string().max(256).optional(),
  overwrite: z.boolean().default(false),
});
router.post('/:id/caption', asyncHandler(async (req, res) => {
  const body = validateRequest(captionSchema, req.body);
  res.status(202).json(await startCaptionRun(req.params.id, body));
}));

router.get('/:id/caption-runs/:runId/events', asyncHandler(async (req, res) => {
  if (!attachCaptionSseClient(req.params.runId, res)) {
    throw new ServerError(`Caption run not found: ${req.params.runId}`, { status: 404, code: 'NOT_FOUND' });
  }
}));

// Bulk caption lint — strip the identity fragments shared across most captions
// so the trigger token (not the caption phrases) learns the character. The
// server recomputes the shared set itself; no request body.
router.post('/:id/strip-shared-fragments', asyncHandler(async (req, res) => {
  res.json(await stripSharedCaptionFragments(req.params.id));
}));

const imagePatchSchema = z.object({ caption: z.string().max(2000) });
router.patch('/:id/images/:imageId', asyncHandler(async (req, res) => {
  const { caption } = validateRequest(imagePatchSchema, req.body);
  res.json(await updateImageCaption(req.params.id, req.params.imageId, caption));
}));

router.delete('/:id/images/:imageId', asyncHandler(async (req, res) => {
  res.json(await deleteImage(req.params.id, req.params.imageId));
}));

export default router;
