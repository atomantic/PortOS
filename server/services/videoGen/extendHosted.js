/**
 * Extend a hosted clip (#16150): continue a clip PortOS rendered on a fal model whose catalog row declares an
 * `extend` endpoint (Veo 3.1 Fast). `dryRun` returns the exact body and price without sending anything; the
 * submit hosts the source clip on fal's CDN and queues one paid job. The preview and the submit build the
 * request with the same code. The new history row records `extendedFrom`; a Music Video caller names the take
 * it extends, and the hook files the result as an unselected child take (musicVideoSceneVideoHook.js).
 */

import { existsSync } from 'fs';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS } from '../../lib/fileUtils.js';
import { probeVideoGeometry, safeUnder } from '../../lib/ffmpeg.js';
import { buildFalVideoRequest, falExtendModel, falExtendSourceProblem } from '../../lib/falVideoModels.js';
import { getHistoryItem } from './history.js';

const refuse = (status, code, message) => { throw new ServerError(message, { status, code }); };

// The one aspect the endpoint takes that matches the source clip.
const sourceAspect = ({ width, height }) => (width >= height ? '16:9' : '9:16');

/** Check a Music Video take names this clip on a real shot, so a child never files against the wrong one. */
async function assertTakeOwnsClip({ projectId, sceneId, takeId }, historyId) {
  const { requireProject } = await import('../musicVideo/requireProject.js');
  const project = await requireProject(projectId);
  const scene = project.scenes?.find((entry) => entry.sceneId === sceneId);
  if (!scene) refuse(404, 'NOT_FOUND', 'Scene not found');
  const take = scene.takes?.find((entry) => entry.takeId === takeId);
  if (take?.kind !== 'video' || take.assetId !== historyId) refuse(409, 'EXTEND_TAKE_MISMATCH', 'That take is not this clip on this shot');
  return take;
}

/**
 * Plan (and with `dryRun: false`, queue) one extension of history row `historyId`.
 * `musicVideo`: `{ projectId, sceneId, takeId }`, optional.
 */
export async function extendHistoryClip(historyId, { prompt, dryRun = false, musicVideo = null } = {}) {
  const row = await getHistoryItem(historyId);
  if (!row) refuse(404, 'NOT_FOUND', 'Video not found');
  const model = falExtendModel(row.modelId);
  if (!model) refuse(409, 'EXTEND_UNSUPPORTED', 'This clip was not rendered by a model that can extend it');
  const sourcePath = row.filename ? safeUnder(PATHS.videos, row.filename) : null;
  if (!sourcePath || !existsSync(sourcePath)) refuse(409, 'EXTEND_SOURCE_MISSING', 'The source clip file is missing');
  const geometry = await probeVideoGeometry(sourcePath);
  const problem = falExtendSourceProblem(model, geometry || {});
  if (problem) refuse(400, 'EXTEND_SOURCE_UNSUITABLE', problem);
  const parentTake = musicVideo ? await assertTakeOwnsClip(musicVideo, historyId) : null;

  let built;
  try {
    // The prompt is sent exactly as the director wrote it.
    built = buildFalVideoRequest({ modelId: model.id, prompt, videoUrl: 'pending:video', aspectRatio: sourceAspect(geometry) });
  } catch (err) {
    if (err?.code !== 'FAL_MODEL_INPUT') throw err;
    return refuse(400, 'VALIDATION_ERROR', err.message);
  }
  const plan = {
    sourceId: historyId,
    modelId: model.id,
    modelLabel: model.label,
    sourceSec: geometry.durationSec,
    seconds: built.seconds,
    resolution: built.resolution,
    estimatedCostUsd: built.estimatedCostUsd,
    prompt: built.body.prompt,
    body: built.body,
  };
  if (dryRun) return { dryRun: true, ...plan };

  const { enqueueJob } = await import('../mediaJobQueue/index.js');
  const params = {
    mode: 'fal',
    videoMode: 'text',
    modelId: model.id,
    prompt: built.body.prompt,
    negativePrompt: '',
    aspectRatio: built.body.aspect_ratio,
    sourceVideoPath: sourcePath,
    extendedFrom: historyId,
    extendSourceSec: geometry.durationSec,
    ...(musicVideo ? {
      musicVideo: { projectId: musicVideo.projectId, sceneId: musicVideo.sceneId },
      // The child is stale against the same shot inputs its parent was made for.
      ...(parentTake.dependencies ? { musicVideoDependencies: parentTake.dependencies } : {}),
      musicVideoExtend: { parentTakeId: musicVideo.takeId, sourceSec: geometry.durationSec, extensionSec: built.seconds },
    } : {}),
    ...(Number.isFinite(built.estimatedCostUsd) ? { musicVideoCostUsd: built.estimatedCostUsd, musicVideoCostModelId: model.id } : {}),
  };
  const { jobId } = await enqueueJob({ kind: 'video', owner: musicVideo ? `music-video-extend:${musicVideo.projectId}` : 'video-extend', params });
  console.log(`🎞️ extend ${historyId.slice(0, 8)} → ${model.id} ${built.seconds}s request ${jobId.slice(0, 8)}`);
  return { dryRun: false, jobId, generationId: jobId, ...plan };
}
