/**
 * Storyboards routes — boards, beats, panels and panel art takes
 * (Create › Storyboards). Every mutation answers with the whole board so the
 * client applies its own write at once; no list re-fetch.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  storyboardBeatCreateSchema, storyboardBeatUpdateSchema, storyboardCreateSchema, storyboardMoveSchema,
  storyboardPanelCreateSchema, storyboardPanelMoveSchema, storyboardPanelNodeUpdateSchema, storyboardPanelUpdateSchema,
  storyboardBeatsAddSchema, storyboardPlotExtractSchema, storyboardRecipeSchema, storyboardSavedRecipeSchema, storyboardTakeCreateSchema, storyboardUpdateSchema,
} from '../lib/storyboardValidation.js';
import {
  addBeat, addPanel, addPanelTake, createStoryboard, deleteBeat, deletePanel, deleteStoryboard, getStoryboard,
  listStoryboards, moveBeat, movePanel, removePanelTake, selectPanelTake, updateBeat, updatePanel,
  updateStoryboard,
} from '../services/storyboards/index.js';
import {
  getMakeEmptyPlan, getPanelMake, runPanelNode, startMakeEmpty, updatePanelNode, updateRecipe,
} from '../services/storyboards/make.js';
import { addBeats, extractBeats } from '../services/storyboards/plot.js';
import { deleteSavedRecipe, listSavedRecipes, saveRecipe } from '../services/storyboards/recipeLibrary.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await listStoryboards());
}));

router.post('/', asyncHandler(async (req, res) => {
  res.status(201).json(await createStoryboard(validateRequest(storyboardCreateSchema, req.body ?? {})));
}));

// The saved recipe library sits before /:id; a board id always starts "sb-".
router.get('/recipes', asyncHandler(async (_req, res) => {
  res.json(await listSavedRecipes());
}));

router.post('/recipes', asyncHandler(async (req, res) => {
  res.status(201).json(await saveRecipe(validateRequest(storyboardSavedRecipeSchema, req.body ?? {})));
}));

router.delete('/recipes/:recipeId', asyncHandler(async (req, res) => {
  res.json(await deleteSavedRecipe(req.params.recipeId));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await getStoryboard(req.params.id));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  res.json(await updateStoryboard(req.params.id, validateRequest(storyboardUpdateSchema, req.body ?? {})));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await deleteStoryboard(req.params.id));
}));

router.post('/:id/beats', asyncHandler(async (req, res) => {
  const { index, ...fields } = validateRequest(storyboardBeatCreateSchema, req.body ?? {});
  res.status(201).json(await addBeat(req.params.id, fields, { index }));
}));

router.patch('/:id/beats/:beatId', asyncHandler(async (req, res) => {
  res.json(await updateBeat(req.params.id, req.params.beatId, validateRequest(storyboardBeatUpdateSchema, req.body ?? {})));
}));

router.delete('/:id/beats/:beatId', asyncHandler(async (req, res) => {
  res.json(await deleteBeat(req.params.id, req.params.beatId));
}));

router.post('/:id/beats/:beatId/move', asyncHandler(async (req, res) => {
  const { index } = validateRequest(storyboardMoveSchema, req.body ?? {});
  res.json(await moveBeat(req.params.id, req.params.beatId, index));
}));

router.post('/:id/beats/:beatId/panels', asyncHandler(async (req, res) => {
  const { index, ...fields } = validateRequest(storyboardPanelCreateSchema, req.body ?? {});
  res.status(201).json(await addPanel(req.params.id, req.params.beatId, fields, { index }));
}));

router.patch('/:id/panels/:panelId', asyncHandler(async (req, res) => {
  res.json(await updatePanel(req.params.id, req.params.panelId, validateRequest(storyboardPanelUpdateSchema, req.body ?? {})));
}));

router.delete('/:id/panels/:panelId', asyncHandler(async (req, res) => {
  res.json(await deletePanel(req.params.id, req.params.panelId));
}));

router.post('/:id/panels/:panelId/move', asyncHandler(async (req, res) => {
  res.json(await movePanel(req.params.id, req.params.panelId, validateRequest(storyboardPanelMoveSchema, req.body ?? {})));
}));

router.post('/:id/panels/:panelId/takes', asyncHandler(async (req, res) => {
  res.status(201).json(await addPanelTake(req.params.id, req.params.panelId, validateRequest(storyboardTakeCreateSchema, req.body ?? {})));
}));

router.post('/:id/panels/:panelId/takes/:takeId/select', asyncHandler(async (req, res) => {
  res.json(await selectPanelTake(req.params.id, req.params.panelId, req.params.takeId));
}));

router.delete('/:id/panels/:panelId/takes/:takeId', asyncHandler(async (req, res) => {
  res.json(await removePanelTake(req.params.id, req.params.panelId, req.params.takeId));
}));

// Panel maker (Make tab): the board's recipe, and each node's run for one panel.
router.put('/:id/recipe', asyncHandler(async (req, res) => {
  const { recipe } = validateRequest(storyboardRecipeSchema, req.body ?? {});
  res.json(await updateRecipe(req.params.id, recipe));
}));

router.get('/:id/panels/:panelId/make', asyncHandler(async (req, res) => {
  res.json(await getPanelMake(req.params.id, req.params.panelId));
}));

router.patch('/:id/panels/:panelId/make/:nodeId', asyncHandler(async (req, res) => {
  res.json(await updatePanelNode(req.params.id, req.params.panelId, req.params.nodeId, validateRequest(storyboardPanelNodeUpdateSchema, req.body ?? {})));
}));

// An LLM node answers when its run finishes; an image node answers once its
// frames are queued (storyboard:make follows each frame).
router.post('/:id/panels/:panelId/make/:nodeId/run', asyncHandler(async (req, res) => {
  res.json(await runPanelNode(req.params.id, req.params.panelId, req.params.nodeId));
}));

// Beats from a plot summary: extract answers with a preview (the board only
// keeps the plot and LLM pick); add appends the beats the user keeps.
router.post('/:id/beats/extract', asyncHandler(async (req, res) => {
  res.json(await extractBeats(req.params.id, validateRequest(storyboardPlotExtractSchema, req.body ?? {})));
}));

router.post('/:id/beats/add', asyncHandler(async (req, res) => {
  res.json(await addBeats(req.params.id, validateRequest(storyboardBeatsAddSchema, req.body ?? {}).beats));
}));

// Make empty panels: GET names what a run would do (panels, nodes, models);
// POST starts it and answers at once, with storyboard:make-batch after.
router.get('/:id/make-empty', asyncHandler(async (req, res) => {
  res.json(await getMakeEmptyPlan(req.params.id));
}));

router.post('/:id/make-empty', asyncHandler(async (req, res) => {
  res.status(202).json(await startMakeEmpty(req.params.id));
}));

export default router;
