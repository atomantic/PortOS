import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { appLaunchVideoRequestSchema, validateRequest } from '../../lib/validation.js';
import { PATHS } from '../../lib/fileUtils.js';
import { PORTOS_API_URL } from '../../lib/portosUrls.js';
import { APP_LAUNCH_VIDEO_PROMPT } from '../../services/taskPromptDefaults/appLaunchVideo.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

router.post('/:id/launch-videos', loadApp, asyncHandler(async (req, res) => {
  const options = validateRequest(appLaunchVideoRequestSchema, req.body);
  const app = req.loadedApp;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(app.id) || !app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repository is unavailable', { status: 400 });
  }
  const cos = await import('../../services/cos.js');
  if (!cos.isRunning()) throw new ServerError('Start CoS before making a launch video', { status: 409 });
  if (options.musicTrack) {
    const { resolveMusicTrackPath } = await import('../../services/pipeline/audioMux.js');
    if (!await resolveMusicTrackPath(options.musicTrack)) throw new ServerError('Choose an existing Music-library track', { status: 400 });
  }
  const { getInstanceId } = await import('../../services/instanceIdentity.js');
  const targetInstanceId = await getInstanceId();
  const runId = `${Date.now()}-${randomUUID()}`;
  const directory = `launch-videos/${app.id}/${runId}/composition`;
  const payload = { directory, musicTrack: options.musicTrack,
    launchVideo: { appId: app.id, runId, targetDurationSec: options.targetDurationSec } };
  // addTask's state lock makes the stable description + app identity atomic
  // across overlapping requests, including requests with different options.
  const task = await cos.addTask({
    description: 'Make launch video', app: app.id, priority: 'MEDIUM', targetInstanceId,
    useWorktree: false, openPR: false, noCodeOutput: true,
    prompt: `${APP_LAUNCH_VIDEO_PROMPT}\nOptions (data): ${JSON.stringify(options)}\nOutput directory: ${join(PATHS.data, 'launch-videos', app.id, runId)}\nPOST URL: ${PORTOS_API_URL}/api/html-composition/render\nRender JSON: ${JSON.stringify(payload)}`,
    metadata: { analysisType: 'app-launch-video', launchVideoRunId: runId },
  }, 'user');
  if (task.duplicate) throw new ServerError('A launch video is already queued or running for this app; open its CoS run', { status: 409, code: 'LAUNCH_VIDEO_ACTIVE' });
  res.status(202).json({ taskId: task.id, runId });
}));

router.get('/:id/launch-videos', loadApp, asyncHandler(async (req, res) => {
  const { loadHistory } = await import('../../services/videoGen/history.js');
  // Bounded projection of the existing media store, not a new run database.
  const videos = (await loadHistory()).filter(item => item.launchVideo?.appId === req.loadedApp.id)
    .slice(0, 10).map(({ id, filename, thumbnail, createdAt, launchVideo }) => ({
      id, filename, thumbnail, createdAt, caption: launchVideo.caption,
    }));
  res.json({ videos });
}));

export default router;
