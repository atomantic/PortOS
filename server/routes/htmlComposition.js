import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { MOTION_SKILL_PACKS, detectMotionSkills, skillInstallCommand } from '../lib/motionSkills.js';
import { enqueueJob, attachSseClient, cancelJob } from '../services/mediaJobQueue/index.js';

import { execFile } from '../lib/childProcess.js';
import { htmlCompositionRenderSchema } from '../lib/htmlCompositionValidation.js';
const router = Router();

// What the optional motion toolkit (`npm run setup:motion`) has installed, so
// the launch-video form can offer only components that are actually present.
router.get('/toolkit', asyncHandler(async (req, res) => {
  const { findFfmpeg } = await import('../lib/ffmpeg.js');
  res.json({ ffmpeg: Boolean(await findFfmpeg()), skillPacks: detectMotionSkills() });
}));

// One-click equivalent of `npm run setup:motion -- --skills`: installs every
// missing skill pack user-wide through the `skills` CLI. Explicit user action
// (a button), never run on boot.
let skillInstall = null;
router.post('/toolkit/skills/install', asyncHandler(async (req, res) => {
  if (skillInstall) throw new ServerError('A motion skills install is already running', { status: 409, code: 'INSTALL_IN_PROGRESS' });
  const packs = detectMotionSkills().filter(pack => !pack.installed);
  const sources = new Map(MOTION_SKILL_PACKS.map(pack => [pack.id, pack]));
  const failed = [];
  skillInstall = (async () => {
    for (const { id, label } of packs) {
      const [command, args] = skillInstallCommand(sources.get(id));
      console.log(`🎬 Installing ${label} motion skills`);
      const ok = await new Promise(resolve => execFile(command, args, { timeout: 5 * 60 * 1000, shell: process.platform === 'win32' }, error => {
        if (error) console.error(`❌ ${label} skill install failed: ${error.message.split('\n')[0]}`);
        resolve(!error);
      }));
      if (!ok) failed.push(label);
    }
  })();
  await skillInstall.finally(() => { skillInstall = null; });
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
  res.json(await cancelJob(req.params.jobId));
}));

export default router;
