import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { catalogPrimitiveOwnerSchema, catalogPrimitiveForkSchema, catalogRefinementSchema, catalogMediaRefineSchema, catalogDesignSpreadSchema, catalogDesignRenderSchema } from '../lib/catalogValidation.js';
import { getIngredient } from '../services/catalogDB/ingredients.js';
import { getPrimitiveContext, setPrimitiveOwner, forkPrimitive } from '../services/catalogPrimitives.js';

const router = Router({ mergeParams: true });

router.post('/media/refine/compose', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMediaRefineSchema, req.body);
  const { refineCatalogMedia } = await import('../services/catalogMediaRefinement.js');
  res.json(await refineCatalogMedia(req.params.id, body, { preview: true }));
}));
router.post('/media/refine', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogMediaRefineSchema, req.body);
  const { refineCatalogMedia } = await import('../services/catalogMediaRefinement.js');
  res.json(await refineCatalogMedia(req.params.id, body));
}));

// Casting > Design rounds: a provider writes face lines, then a round renders.
const design = () => import('../services/catalogDesign.js');
router.post('/design/spread/compose', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogDesignSpreadSchema, req.body);
  res.json(await (await design()).spreadCatalogDesign(req.params.id, body, { preview: true }));
}));
router.post('/design/spread', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogDesignSpreadSchema, req.body);
  res.json(await (await design()).spreadCatalogDesign(req.params.id, body));
}));
router.post('/design/render/compose', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogDesignRenderSchema, req.body);
  res.json(await (await design()).renderCatalogDesign(req.params.id, body, { preview: true }));
}));
router.post('/design/render', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogDesignRenderSchema, req.body);
  res.json(await (await design()).renderCatalogDesign(req.params.id, body));
}));

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
