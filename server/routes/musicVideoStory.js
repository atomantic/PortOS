import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { storyApplySchema, storyBeatsApplySchema, storyProposeSchema, storySummarySchema } from '../lib/musicVideoStoryValidation.js';
import { applyStory, applyStoryBeats, proposeStory, saveStorySummary, storyContext } from '../services/musicVideo/story.js';

const router = Router();
let authGateModule;
router.get('/:id/story/context', asyncHandler(async (req, res) => {
  res.json(await storyContext(req.params.id));
}));
router.put('/:id/story/summary', asyncHandler(async (req, res) => {
  res.json(await saveStorySummary(req.params.id, validateRequest(storySummarySchema, req.body)));
}));
router.post('/:id/story/propose', asyncHandler(async (req, res) => {
  const { requestHasHostControl } = await (authGateModule ??= import('../services/authGate.js'));
  res.json(await proposeStory(req.params.id, validateRequest(storyProposeSchema, req.body), { hasHostControl: requestHasHostControl(req) }));
}));
router.post('/:id/story/apply', asyncHandler(async (req, res) => {
  res.json(await applyStory(req.params.id, validateRequest(storyApplySchema, req.body)));
}));
router.post('/:id/story/beats', asyncHandler(async (req, res) => {
  res.json(await applyStoryBeats(req.params.id, validateRequest(storyBeatsApplySchema, req.body)));
}));
export default router;
