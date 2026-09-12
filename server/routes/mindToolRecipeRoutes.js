/** User-owned library management follows the existing Mind settings auth gate.
 * No manageToolRecipes grant is required for the human's own HTTP edits. */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  mindToolRecipeSaveSchema, mindToolRecipeUpdateSchema,
  mindToolRecipeRevisionSchema, mindToolRecipeRestoreSchema,
} from '../lib/mindToolRecipes.js';

const router = Router();
const recipeIdSchema = z.object({ recipeId: z.uuid() });
const service = () => import('../services/mindToolRecipes.js');
const id = (req) => validateRequest(recipeIdSchema, req.params).recipeId;

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await (await service()).listRecipes());
}));
router.post('/validate', asyncHandler(async (req, res) => {
  const { definition } = validateRequest(mindToolRecipeSaveSchema, req.body);
  const { valid, runtimeChecks } = await (await service()).validateRecipe(definition);
  res.json({ valid, runtimeChecks });
}));
router.post('/', asyncHandler(async (req, res) => {
  const { definition } = validateRequest(mindToolRecipeSaveSchema, req.body);
  res.status(201).json(await (await service()).createRecipe(definition));
}));
router.get('/:recipeId', asyncHandler(async (req, res) => {
  const recipeId = id(req);
  res.json(await (await service()).getRecipe(recipeId));
}));
router.put('/:recipeId', asyncHandler(async (req, res) => {
  const recipeId = id(req);
  const body = validateRequest(mindToolRecipeUpdateSchema, req.body);
  res.json(await (await service()).updateRecipe(recipeId, body));
}));
router.post('/:recipeId/archive', asyncHandler(async (req, res) => {
  const recipeId = id(req);
  const body = validateRequest(mindToolRecipeRevisionSchema, req.body);
  res.json(await (await service()).archiveRecipe(recipeId, body));
}));
router.post('/:recipeId/restore', asyncHandler(async (req, res) => {
  const recipeId = id(req);
  const body = validateRequest(mindToolRecipeRestoreSchema, req.body);
  res.json(await (await service()).restoreRecipe(recipeId, body));
}));
export default router;
