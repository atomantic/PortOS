import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { EFFORT_LEVELS } from '../lib/providerModels.js';
import {
  GENERAL_FAMILY_ID,
  THREEJS_MODEL_FAMILY_IDS,
  THREEJS_MODEL_FAMILY_OPTIONS,
} from '../lib/threejsModelFamilies.js';
import { emptyToNull } from '../lib/zodCompat.js';
import {
  listModels,
  getModel,
  createModel,
  startGeneration,
  deleteModel,
  getModelSource,
} from '../services/threejsModels/index.js';

const router = Router();

const galleryFilenameSchema = z.string().trim().min(1).max(256)
  .regex(/^[^/\\]+\.png$/i, 'filename must be a gallery PNG basename');

// Reasoning-effort override. The picker's "Default effort" choice submits `''`,
// which maps to an explicit `null` CLEAR — distinct from the key being absent,
// which leaves the record's stored effort alone (see startGeneration).
const effortSchema = z.preprocess(emptyToNull, z.enum(EFFORT_LEVELS).nullable().optional());

// Subject-family checklist. Unlike `effort` there is no "clear" state — the
// picker's General choice submits the real `general` id, so an empty string is
// normalized to it rather than to `null`.
//
// A family id this install does not ship gets the same treatment rather than a
// 400. The picker can only offer ids the server served, so an unrecognized
// STRING is never fresh user intent — it is a record written by a build with a
// larger taxonomy (a downgrade, or a backup restored from a machine ahead of
// this one), which the detail page reads straight back into its refine request.
// Rejecting it would make that record permanently un-refinable; coercing it
// degrades to "no checklist" exactly like every other layer and self-heals the
// record on the next generate. A non-string is a malformed body, not a stale
// value, and still falls through to the enum and a 400.
const familySchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (value === '') return GENERAL_FAMILY_ID;
  return THREEJS_MODEL_FAMILY_IDS.includes(value) ? value : GENERAL_FAMILY_ID;
}, z.enum(THREEJS_MODEL_FAMILY_IDS).optional());

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  filename: galleryFilenameSchema,
  prompt: z.string().trim().max(2_000).default(''),
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().max(256).optional(),
  effort: effortSchema,
  family: familySchema,
});

const generateSchema = z.object({
  providerId: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().max(256).optional(),
  effort: effortSchema,
  prompt: z.string().trim().max(2_000).optional(),
  family: familySchema,
  feedback: z.string().trim().max(2_000).default(''),
});

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listModels());
}));

router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(createSchema, req.body);
  const model = await createModel(input);
  res.status(202).json(model);
}));

// Registered ahead of `/:id` so the literal path is not read as a model id. The
// taxonomy is served rather than mirrored into the client so the picker and the
// prompt splice can never drift apart.
router.get('/families', (_req, res) => {
  res.json(THREEJS_MODEL_FAMILY_OPTIONS);
});

router.get('/:id/source', asyncHandler(async (req, res) => {
  const result = await getModelSource(req.params.id);
  res.set('Content-Type', 'text/javascript; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send(result.source);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const model = await getModel(req.params.id);
  if (!model) throw new ServerError('Three.js model not found', { status: 404, code: 'NOT_FOUND' });
  res.json(model);
}));

router.post('/:id/generate', asyncHandler(async (req, res) => {
  const input = validateRequest(generateSchema, req.body ?? {});
  const model = await startGeneration(req.params.id, input);
  res.status(202).json(model);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await deleteModel(req.params.id));
}));

export default router;
