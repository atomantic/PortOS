import { createSchema, generateSchema, productSheetQuerySchema } from '../lib/threejsModelsValidation.js';
import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { THREEJS_MODEL_FAMILY_OPTIONS } from '../lib/threejsModelFamilies.js';
import {
  listModels,
  getModel,
  createModel,
  startGeneration,
  deleteModel,
  getModelSource,
} from '../services/threejsModels/index.js';
import { findProductSheetForImage } from '../services/threejsModels/productSheet.js';

const router = Router();

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

// Literal path ahead of `/:id`. Read-only: `sheet` is null for an image that is
// not a Casting object's or whose object has no product sheet.
router.get('/product-sheet', asyncHandler(async (req, res) => {
  const { filename } = validateRequest(productSheetQuerySchema, req.query);
  res.json({ sheet: await findProductSheetForImage(filename) });
}));

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
