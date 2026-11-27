/** Submit an upscale of the selected Music Video shot clip and attach the derived take. */

import { ServerError } from '../../lib/errorHandler.js';
import { assertMusicVideoMedia } from '../../lib/musicVideo/musicVideoMediaPolicy.js';
import { sceneClipIsFinal, sceneFinalApproved } from '../../lib/musicVideo/musicVideoFinalApproval.js';
import { appendSceneTakes } from './projects.js';
import { requireProject } from './requireProject.js';
import { musicVideoEvents } from './events.js';

const submitting = new Set();

export async function submitShotUpscale(projectId, sceneId, historyId, {
  method, targetResolution, topazToken, requireApproval = false,
}) {
  const key = JSON.stringify([projectId, sceneId]);
  const pendingError = () => new ServerError('An upscale is already in progress for this shot.', { status: 409, code: 'UPSCALE_PENDING' });
  if (submitting.has(key)) throw pendingError();
  submitting.add(key);
  try {
    const project = await requireProject(projectId);
    const scene = project.scenes?.find((entry) => entry.sceneId === sceneId);
    if (!scene) throw new ServerError('Shot not found', { status: 404, code: 'NOT_FOUND' });
    if (scene.videoHistoryId !== historyId || (requireApproval && (sceneClipIsFinal(scene) || !sceneFinalApproved(scene)))) {
      throw new ServerError('The selected shot clip or its approval changed. Review the shot and try again.', { status: 409, code: 'UPSCALE_SHOT_CHANGED' });
    }
    assertMusicVideoMedia(project, 'video', 'shot upscale');
    const { listInFlightSceneJobs } = await import('./sceneJobs.js');
    if (listInFlightSceneJobs(projectId).some((job) => job.lane === 'upscale' && job.sceneId === sceneId)) throw pendingError();

    const musicVideo = { projectId, sceneId, tier: 'final', selectOnComplete: true };
    if (method === 'fal-seedvr2') {
      const { enqueueFalSeedvr2Upscale } = await import('../videoGen/falUpscaleJob.js');
      return { job: await enqueueFalSeedvr2Upscale(historyId, { targetResolution, musicVideo }) };
    }
    if (method === 'local-ltx25') {
      const { enqueueLtxUpscale } = await import('../videoGen/upscaleJob.js');
      return { job: await enqueueLtxUpscale(historyId, { musicVideo }) };
    }
    if (method === 'fal-topaz') {
      if (!topazToken) throw new ServerError('Request and confirm a Topaz credit estimate first.', { status: 400, code: 'TOPAZ_QUOTE_REQUIRED' });
      const { enqueueTopazUpscale } = await import('../videoGen/topazJob.js');
      return { job: await enqueueTopazUpscale(historyId, topazToken, { musicVideo }) };
    }
    if (method !== 'lanczos') {
      throw new ServerError('This upscale method is unavailable on PortOS.', { status: 422, code: 'UPSCALE_METHOD_UNAVAILABLE' });
    }

    const { upscaleHistoryItem } = await import('../videoGen/upscaleVideo.js');
    const video = await upscaleHistoryItem(historyId, { method });
    const { scene: updated, appended } = await appendSceneTakes(projectId, sceneId, [{
      kind: 'video', assetId: video.id, source: 'generated', provider: 'portos', tier: 'final', upscaledFrom: historyId,
    }]);
    const takeId = appended[0].takeId;
    musicVideoEvents.emit('scene-video', {
      projectId, sceneId, videoHistoryId: updated.videoHistoryId, takes: updated.takes,
      lastFailure: updated.lastFailure ?? null, takeId,
    });
    return { video, scene: updated, takeId };
  } finally {
    submitting.delete(key);
  }
}
