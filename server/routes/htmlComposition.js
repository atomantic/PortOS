import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, htmlCompositionRenderSchema } from '../lib/validation.js';
import { enqueueJob, attachSseClient, cancelJob } from '../services/mediaJobQueue/index.js';

const router = Router();

router.post('/render', asyncHandler(async (req, res) => {
  const params = validateRequest(htmlCompositionRenderSchema, req.body);
  if (params.launchVideo || params.directory.split('/')[0] === 'launch-videos') {
    const { snapshotAssets } = await import('../services/htmlComposition/browser.js');
    const { validateLaunchVideoAssets } = await import('../lib/launchVideoValidation.js');
    validateLaunchVideoAssets(await snapshotAssets(params.directory), params.launchVideo);
  }
  res.status(202).json(await enqueueJob({ kind: 'html-composition', params }));
}));

router.get('/:jobId/events', (req, res) => {
  if (!attachSseClient(req.params.jobId, res)) throw new ServerError('Job not found or expired', { status: 404 });
});

router.post('/:jobId/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelJob(req.params.jobId));
}));

export default router;
