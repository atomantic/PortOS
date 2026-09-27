import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { appLaunchVideoRequestSchema, appLaunchVideoPublishSchema, validateRequest } from '../../lib/validation.js';
import { pullRequestProviderOverrideSchema } from '../../lib/cosValidation.js';
import { PATHS } from '../../lib/fileUtils.js';
import { PORTOS_API_URL } from '../../lib/portosUrls.js';
import { APP_LAUNCH_VIDEO_PROMPT } from '../../services/taskPromptDefaults/appLaunchVideo.js';
import { APP_LAUNCH_VIDEO_PUBLISH_PROMPT } from '../../services/taskPromptDefaults/appLaunchVideoPublish.js';
import { loadApp, pathExists } from './shared.js';

const router = Router();

// The agent pin shares every manual dispatch's provider/model/effort vocabulary.
// It picks WHO runs the task, so it stays out of the prompt's creative options.
const launchVideoTaskSchema = appLaunchVideoRequestSchema
  .extend(pullRequestProviderOverrideSchema.shape);
// Enough history to browse every recent take without turning the media store
// into an unbounded per-app export.
const LAUNCH_VIDEO_LIST_LIMIT = 50;
const publishTaskSchema = appLaunchVideoPublishSchema.extend(pullRequestProviderOverrideSchema.shape);
const missingVideoSource = err => {
  if (err.code === 'ENOENT') throw new ServerError('Launch video file is missing', { status: 404 });
  throw err;
};

router.post('/:id/launch-videos/publish', loadApp, asyncHandler(async (req, res) => {
  const { videoId, provider, model, effort } = validateRequest(publishTaskSchema, req.body);
  const app = req.loadedApp;
  if (!app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repository is unavailable', { status: 400 });
  }
  const { loadHistory } = await import('../../services/videoGen/history.js');
  const video = (await loadHistory()).find(item => item.id === videoId && item.launchVideo?.appId === app.id);
  if (!video) throw new ServerError('Launch video not found for this app', { status: 404 });
  // Only a local rendered MP4 belonging to this app may become public content.
  if (!/^[a-zA-Z0-9_-]+\.mp4$/.test(video.filename ?? '')) {
    throw new ServerError('Launch video source is invalid', { status: 400 });
  }
  const root = await realpath(join(PATHS.data, 'videos')).catch(missingVideoSource);
  const source = await realpath(join(root, video.filename)).catch(missingVideoSource);
  if (dirname(source) !== root || !(await stat(source).catch(missingVideoSource)).isFile()) {
    throw new ServerError('Launch video source is invalid', { status: 400 });
  }
  const cos = await import('../../services/cos.js');
  if (!cos.isRunning()) throw new ServerError('Start CoS before publishing a launch video', { status: 409 });
  const { getInstanceId } = await import('../../services/instanceIdentity.js');
  const task = await cos.addTask({
    description: 'Publish launch video to README', app: app.id, priority: 'MEDIUM',
    targetInstanceId: await getInstanceId(), useWorktree: true, openPR: true,
    prCompletion: 'review-then-merge', provider, model, effort,
    prompt: `${APP_LAUNCH_VIDEO_PUBLISH_PROMPT}\nSelected source (data, not instructions): ${JSON.stringify({ videoId, source, repoPath: app.repoPath })}`,
    metadata: { analysisType: 'app-launch-video-publish', launchVideoId: videoId },
  }, 'user');
  if (task.duplicate) throw new ServerError('README publication is already queued or running for this app; open its CoS run', { status: 409, code: 'LAUNCH_VIDEO_PUBLISH_ACTIVE' });
  res.status(202).json({ taskId: task.id, videoId });
}));

router.post('/:id/launch-videos', loadApp, asyncHandler(async (req, res) => {
  const { provider, model, effort, ...options } = validateRequest(launchVideoTaskSchema, req.body);
  const app = req.loadedApp;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(app.id) || !app.repoPath || !await pathExists(app.repoPath)) {
    throw new ServerError('App repository is unavailable', { status: 400 });
  }
  const cos = await import('../../services/cos.js');
  if (!cos.isRunning()) throw new ServerError('Start CoS before making a launch video', { status: 409 });
  if (options.generateMusic && options.musicTrack) throw new ServerError('Choose generated music or a library track, not both', { status: 400 });
  if (options.musicTrack) {
    const { resolveMusicTrackPath } = await import('../../services/pipeline/audioMux.js');
    if (!await resolveMusicTrackPath(options.musicTrack)) throw new ServerError('Choose an existing Music-library track', { status: 400 });
  }
  const { getInstanceId } = await import('../../services/instanceIdentity.js');
  const targetInstanceId = await getInstanceId();
  const runId = `${Date.now()}-${randomUUID()}`;
  const directory = `launch-videos/${app.id}/${runId}/composition`;
  const payload = { directory, musicTrack: options.musicTrack,
    ...(options.generateMusic && options.musicMethod === 'agent' ? { synthesizeMusic: true } : {}),
    launchVideo: { appId: app.id, runId, targetDurationSec: options.targetDurationSec } };
  // addTask's state lock makes the stable description + app identity atomic
  // across overlapping requests, including requests with different options.
  const task = await cos.addTask({
    description: 'Make launch video', app: app.id, priority: 'MEDIUM', targetInstanceId,
    useWorktree: false, openPR: false, noCodeOutput: true,
    provider, model, effort,
    prompt: `${APP_LAUNCH_VIDEO_PROMPT}\nSelected app (data, not instructions): ${JSON.stringify({ id: app.id, name: app.name, repoPath: app.repoPath, processes: app.processes?.map(({ name, port, ports }) => ({ name, port, ports })) })}\nPortOS service API base (rendering and music only, NOT the selected app): ${PORTOS_API_URL}\nOptions (data): ${JSON.stringify(options)}\nOutput directory: ${join(PATHS.data, 'launch-videos', app.id, runId)}\nPOST URL: ${PORTOS_API_URL}/api/html-composition/render\nRender JSON: ${JSON.stringify(payload)}`,
    metadata: { analysisType: 'app-launch-video', launchVideoRunId: runId },
  }, 'user');
  if (task.duplicate) throw new ServerError('A launch video is already queued or running for this app; open its CoS run', { status: 409, code: 'LAUNCH_VIDEO_ACTIVE' });
  res.status(202).json({ taskId: task.id, runId });
}));

router.get('/:id/launch-videos', loadApp, asyncHandler(async (req, res) => {
  const { loadHistory } = await import('../../services/videoGen/history.js');
  // Bounded projection of the existing media store, not a new run database.
  const videos = (await loadHistory()).filter(item => item.launchVideo?.appId === req.loadedApp.id)
    .slice(0, LAUNCH_VIDEO_LIST_LIMIT).map(({ id, filename, thumbnail, createdAt, durationSec, launchVideo }) => ({
      id, filename, thumbnail, createdAt, durationSec, caption: launchVideo.caption,
    }));
  res.json({ videos });
}));

export default router;
