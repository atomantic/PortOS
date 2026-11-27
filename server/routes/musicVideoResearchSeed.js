import { Router } from 'express';
import { assertCancelResult } from '../lib/cancelResponse.js';
import { emptyQuerySchema } from '../lib/queryValidation.js';
import { cancelOperationSchema } from '../lib/sharedSchemas.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { musicVideoResearchSeedSchema } from '../lib/musicVideo/routeValidation/misc.js';
import { cancelResearch, listActiveResearch, startCameoResearch, startSceneResearch } from '../services/musicVideo/researchSeed.js';

const router = Router();

// Research and seed (#14822): start the agent that finds real photos of a shot's subject.
router.post('/:id/scenes/:sceneId/research-seed', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoResearchSeedSchema, req.body);
  const result = await startSceneResearch(req.params.id, req.params.sceneId, input, { hasHostControl: true });
  res.status(result.status === 'running' ? 202 : 200).json(result);
}));

// The same step for a roster cameo (#14821): the photos join the cameo's reference photos.
router.post('/:id/cameos/:cameoId/research-seed', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoResearchSeedSchema, req.body);
  const result = await startCameoResearch(req.params.id, req.params.cameoId, input, { hasHostControl: true });
  res.status(result.status === 'running' ? 202 : 200).json(result);
}));

router.get('/:id/research', (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  res.set('Cache-Control', 'no-store').json({ runs: listActiveResearch(req.params.id) });
});

router.post('/:id/research/cancel', asyncHandler(async (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  const { runId } = validateRequest(cancelOperationSchema, req.body ?? {});
  res.status(202).json(assertCancelResult(cancelResearch(req.params.id, runId), { notFoundMessage: 'Active research run not found' }));
}));

export default router;
