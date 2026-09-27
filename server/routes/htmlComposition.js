import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, htmlCompositionRenderSchema } from '../lib/validation.js';
import { enqueueJob, attachSseClient, cancelJob } from '../services/mediaJobQueue/index.js';

const router = Router();

router.post('/render', asyncHandler(async (req, res) => {
  const params = validateRequest(htmlCompositionRenderSchema, req.body);
  if (params.compositionMusic || params.launchVideo || params.directory.split('/')[0] === 'launch-videos') {
    const { snapshotAssets } = await import('../services/htmlComposition/browser.js');
    const { validateLaunchVideoAssets } = await import('../lib/launchVideoValidation.js');
    const assets = await snapshotAssets(params.directory);
    validateLaunchVideoAssets(assets, params.launchVideo, params.compositionMusic);
    if (params.compositionMusic && !assets.has('/soundtrack.wav')) throw new ServerError('compositionMusic is missing soundtrack.wav', { status: 400 });
    if (params.launchVideo?.appId) {
      const { getAppById } = await import('../services/apps.js');
      if (!await getAppById(params.launchVideo.appId)) throw new ServerError('App not found', { status: 404 });
      const expected = `launch-videos/${params.launchVideo.appId}/${params.launchVideo.runId}/composition`;
      if (params.directory !== expected) throw new ServerError('Launch-video directory does not match its app and run', { status: 400 });
    }
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
