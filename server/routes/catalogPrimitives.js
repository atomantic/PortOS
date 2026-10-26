import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { catalogPrimitiveOwnerSchema, catalogPrimitiveForkSchema, catalogRefinementSchema } from '../lib/catalogValidation.js';
import { getIngredient } from '../services/catalogDB/ingredients.js';
import { getPrimitiveContext, setPrimitiveOwner, forkPrimitive } from '../services/catalogPrimitives.js';

const router = Router({ mergeParams: true });

router.get('/universe-context', asyncHandler(async (req, res) => {
  if (!await getIngredient(req.params.id)) throw new ServerError('Ingredient not found', { status: 404 });
  res.json(await getPrimitiveContext(req.params.id));
}));

router.put('/owner', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogPrimitiveOwnerSchema, req.body);
  res.json(await setPrimitiveOwner(req.params.id, body.universeId));
}));

router.post('/fork', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogPrimitiveForkSchema, req.body);
  res.status(201).json(await forkPrimitive(req.params.id, body));
}));

router.post('/refine/compose', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogRefinementSchema, req.body);
  const { refineCatalogDraft } = await import('../services/catalogRefinement.js');
  res.json(await refineCatalogDraft(req.params.id, body, { preview: true }));
}));
router.post('/refine', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogRefinementSchema, req.body);
  const { refineCatalogDraft } = await import('../services/catalogRefinement.js');
  res.json(await refineCatalogDraft(req.params.id, body));
}));
export default router;
