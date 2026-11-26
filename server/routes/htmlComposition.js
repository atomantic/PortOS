import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { assertCancelResult } from '../lib/cancelResponse.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { MOTION_SKILL_PACKS, detectMotionSkills, installMotionSkillPack } from '../lib/motionSkills.js';
import { enqueueJob, attachSseClient, cancelJob, getJob } from '../services/mediaJobQueue/index.js';

import { htmlCompositionRenderSchema } from '../lib/htmlCompositionValidation.js';
const router = Router();

// What the optional motion toolkit (`npm run setup:motion`) has installed, so
// the launch-video form can offer only components that are actually present.
router.get('/toolkit', asyncHandler(async (req, res) => {
  const { findFfmpeg } = await import('../lib/ffmpeg.js');
  res.set('Cache-Control', 'no-store').json({ ffmpeg: Boolean(await findFfmpeg()), skillPacks: detectMotionSkills(), skillInstall: skillInstall ? { runId: skillInstall } : null });
}));

// One-click equivalent of `npm run setup:motion -- --skills`: installs every
// missing skill pack user-wide from pinned, hash-verified GitHub archives (no npx). Explicit user action
// (a button), never run on boot.
let skillInstall = null;
router.post('/toolkit/skills/install', asyncHandler(async (req, res) => {
  if (skillInstall) throw new ServerError('A motion skills install is already running', { status: 409, code: 'INSTALL_IN_PROGRESS', context: { runId: skillInstall } });
  const packs = detectMotionSkills().filter(pack => !pack.installed);
  const sources = new Map(MOTION_SKILL_PACKS.map(pack => [pack.id, pack]));
  const failed = [];
  skillInstall = randomUUID();
  await (async () => {
    for (const { id, label } of packs) {
      console.log(`🎬 Installing ${label} motion skills`);
      const ok = await installMotionSkillPack(sources.get(id)).then(() => true, error => {
        console.error(`❌ ${label} skill install failed: ${error.message.split('\n')[0]}`);
        return false;
      });
      if (!ok) failed.push(label);
    }
  })().finally(() => { skillInstall = null; });
  if (failed.length) throw new ServerError(`Could not install: ${failed.join(', ')}. Run npm run setup:motion -- --skills for details.`, { status: 502, code: 'MOTION_SKILLS_INSTALL_FAILED' });
  res.json({ skillPacks: detectMotionSkills() });
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
  const { jobId } = req.params;
  const job = getJob(jobId);
  const result = job?.kind === 'html-composition' && await cancelJob(jobId);
  res.json(assertCancelResult(result, { notFoundMessage: 'HTML composition job not found or expired' }));
}));

export default router;
