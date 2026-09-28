import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, htmlCompositionRenderSchema, htmlCompositionBeatsQuerySchema } from '../lib/validation.js';
import { enqueueJob, attachSseClient, cancelJob } from '../services/mediaJobQueue/index.js';

const router = Router();

// What the optional motion toolkit (`npm run setup:motion`) has installed, so
// the launch-video form can offer only components that are actually present.
router.get('/toolkit', asyncHandler(async (req, res) => {
  const [{ findFfmpeg }, { detectMotionSkills }] = await Promise.all([import('../lib/ffmpeg.js'), import('../lib/motionSkills.js')]);
  res.json({ ffmpeg: Boolean(await findFfmpeg()), skillPacks: detectMotionSkills() });
}));

// Measured beat grid for a Music-library track (#8958) — bpm/beats/downbeats/
// onset hits from `lib/beatGrid.js`, so a launch-video agent can cut on the
// real tempo instead of guessing it. `null` bpm (no confident tempo, e.g. an
// ambient/beatless track) is a normal response, not an error.
router.get('/beats', asyncHandler(async (req, res) => {
  const { musicTrack } = validateRequest(htmlCompositionBeatsQuerySchema, req.query);
  const { resolveMusicTrackPath } = await import('../services/pipeline/audioMux.js');
  const trackPath = await resolveMusicTrackPath(musicTrack);
  if (!trackPath) throw new ServerError('Choose an existing Music-library track', { status: 400 });
  const { getBeatGrid } = await import('../lib/beatGrid.js');
  const grid = await getBeatGrid(trackPath);
  if (!grid) throw new ServerError('Could not measure a beat grid for this track (ffmpeg missing or decode failed)', { status: 422 });
  res.json(grid);
}));

router.post('/render', asyncHandler(async (req, res) => {
  const params = validateRequest(htmlCompositionRenderSchema, req.body);
  if (params.launchVideo || params.directory.split('/')[0] === 'launch-videos') {
    const { snapshotAssets } = await import('../services/htmlComposition/browser.js');
    const { validateLaunchVideoAssets } = await import('../lib/launchVideoValidation.js');
    validateLaunchVideoAssets(await snapshotAssets(params.directory), params.launchVideo);
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
