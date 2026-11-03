import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { musicVideoResearchSeedSchema } from '../lib/musicVideoValidation.js';
import { startSceneResearch } from '../services/musicVideo/researchSeed.js';

const router = Router();
let authGateModule;

// Research and seed (#14822): start the agent that finds real photos of a shot's subject.
router.post('/:id/scenes/:sceneId/research-seed', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoResearchSeedSchema, req.body);
  const { requestHasHostControl } = await (authGateModule ??= import('../services/authGate.js'));
  const result = await startSceneResearch(req.params.id, req.params.sceneId, input, { hasHostControl: requestHasHostControl(req) });
  res.status(result.status === 'running' ? 202 : 200).json(result);
}));

export default router;
