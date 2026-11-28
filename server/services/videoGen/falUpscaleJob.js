/**
 * Cloud generative video upscale via fal.ai SeedVR2 (`fal-ai/seedvr/upscale/video`).
 *
 * Rides `mediaJobQueue` on the `cloud` lane (`mode: 'fal'`), mirroring
 * `upscaleJob.js` and `fal.js`: the source clip is never modified, a NEW file
 * and NEW history entry are published atomically inside `withBackupAssetPublication`,
 * and `estimatedCostUsd` + `musicVideo` attribution feed directly into Music Video
 * history, takes, collections and `renderSpend` accounting.
 */

import { readFile, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { probeVideoStreamInfo } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import {
  awaitFalCompletion, cancelFalRequest, createFalRequestEntry,
  hostFalDataUri, readCompletedFalResult, resolveFalApiKey, submitFalRequest,
} from '../falQueue.js';
import { videoGenEvents } from './events.js';
import { getHistoryItem } from './history.js';
import {
  publishUpscaledVideo, removeOwnedUpscaleFile, resolveQueuedUpscaleSource, resolveUpscaleMusicVideo,
} from './upscaleJobHelpers.js';
import { finalizeUpscaleOutput } from './upscaleFfmpeg.js';
import { planUpscaleHistoryItem } from './upscaleVideo.js';
import {
  DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION,
  FAL_SEEDVR2_HISTORY_MODEL_ID,
  FAL_SEEDVR2_MODEL_ID,
  FAL_SEEDVR2_RUNTIME_ID,
  LTX_UPSCALE_JOB_KIND,
  estimateFalSeedvr2CostUsd,
} from './upscalePlan.js';

const FAL_UPSCALE_TIMEOUT_MS = 15 * 60 * 1000;
const FAL_UPSCALE_DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;
const FAL_SEEDVR2_NOISE_SCALE = 0.1;

const activeUpscales = new Map();

const upscaledPrompt = (prompt, targetResolution) => (
  prompt ? `${prompt} (${targetResolution} SeedVR2)` : `(upscaled ${targetResolution} SeedVR2)`
);

/**
 * Validate a fal.ai SeedVR2 upscale request and enqueue it on the cloud lane.
 * Refuses already-upscaled clips or missing `FAL_KEY` before committing a job.
 */
export async function enqueueFalSeedvr2Upscale(historyId, {
  targetResolution = DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION,
  musicVideoProjectId = null,
  sceneId = null,
  musicVideo: shot = null,
} = {}) {
  const plan = await planUpscaleHistoryItem(historyId, { method: 'fal-seedvr2', targetResolution });
  if (plan.alreadyUpscaled) {
    throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
  }
  if (!plan.runtime.installed) {
    throw new ServerError(
      plan.runtime.reason || 'Configure FAL_KEY in Settings → Credentials to use fal.ai SeedVR2 upscaling.',
      { status: 400, code: 'FAL_KEY_MISSING' },
    );
  }
  if (shot && plan.estimatedCostUsd == null) {
    throw new ServerError('The selected clip could not be measured for a cost estimate.', { status: 422, code: 'UPSCALE_GEOMETRY_UNKNOWN' });
  }
  const item = await getHistoryItem(historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });

  return enqueueJob({
    kind: LTX_UPSCALE_JOB_KIND,
    params: {
      mode: 'fal',
      upscaleMethod: 'fal-seedvr2',
      historyId: item.id,
      sourceFilename: item.filename,
      targetResolution,
      prompt: upscaledPrompt(item.prompt, targetResolution),
      width: plan.target.width,
      height: plan.target.height,
      numFrames: plan.target.frameCount,
      fps: plan.source.fps,
      ...(plan.estimatedCostUsd != null ? {
        estimatedCostUsd: plan.estimatedCostUsd,
        musicVideoCostUsd: plan.estimatedCostUsd,
        musicVideoCostModelId: FAL_SEEDVR2_HISTORY_MODEL_ID,
      } : {}),
      ...resolveUpscaleMusicVideo(item, { musicVideo: shot, musicVideoProjectId, sceneId }),
    },
  });
}

/** Cancel an in-flight fal.ai SeedVR2 upscale job locally and remotely. */
export async function cancel(jobId) {
  const entry = activeUpscales.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.controller.abort();
  await cancelFalRequest(entry);
  return true;
}

/** Queue worker invoked by `mediaJobQueue` for `kind: 'video-upscale', mode: 'fal'`. */
export async function runVideoUpscale(request) {
  const {
    jobId,
    historyId,
    sourceFilename,
    targetResolution = DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION,
    musicVideo = null,
  } = request;

  const settings = await getSettings();
  const apiKey = resolveFalApiKey(settings);
  if (!apiKey) {
    const error = 'Configure FAL_KEY in Settings → Credentials to use fal.ai SeedVR2 upscaling.';
    videoGenEvents.emit('failed', { generationId: jobId, error });
    return null;
  }

  const entry = createFalRequestEntry(apiKey);
  activeUpscales.set(jobId, entry);
  const renderStartedAtMs = Date.now();
  const scratch = [];
  let unpublishedPath = null;
  let result = null;
  let failureReason = null;

  try {
    const { item, sourcePath } = await resolveQueuedUpscaleSource(historyId, sourceFilename);

    const sourceStream = await probeVideoStreamInfo(sourcePath);
    const sourceBytes = await readFile(sourcePath);
    const dataUri = `data:video/mp4;base64,${sourceBytes.toString('base64')}`;

    console.log(`🔍 Upscaling video [${historyId.slice(0, 8)}] on fal-seedvr2 → ${targetResolution}`);
    videoGenEvents.emit('progress', { generationId: jobId, progress: 0.05, status: 'Uploading clip to fal.ai…' });
    videoGenEvents.emit('activity', { generationId: jobId });

    const videoUrl = await hostFalDataUri({
      apiKey,
      dataUri,
      fileName: `upscale-${historyId.slice(0, 8)}`,
      signal: entry.controller.signal,
    });

    const receipt = await submitFalRequest({
      apiKey,
      modelId: FAL_SEEDVR2_MODEL_ID,
      body: {
        video_url: videoUrl,
        upscale_mode: 'target',
        target_resolution: targetResolution,
        noise_scale: FAL_SEEDVR2_NOISE_SCALE,
      },
    });
    entry.cancelUrl = receipt.cancel_url;

    const deadline = Date.now() + FAL_UPSCALE_TIMEOUT_MS;
    const completion = await awaitFalCompletion({
      entry,
      statusUrl: receipt.status_url,
      apiKey,
      deadline,
      timeoutMs: FAL_UPSCALE_TIMEOUT_MS,
      onPoll: () => videoGenEvents.emit('activity', { generationId: jobId }),
      onStatus: (status) => {
        const label = status === 'IN_QUEUE' ? 'Queued on fal.ai SeedVR2…' : 'Upscaling on fal.ai SeedVR2…';
        videoGenEvents.emit('progress', { generationId: jobId, progress: status === 'IN_QUEUE' ? 0.15 : 0.5, status: label });
      },
    });
    if (completion.outcome === 'canceled') {
      throw new ServerError('Upscale canceled', { status: 499, code: 'UPSCALE_CANCELED' });
    }
    if (completion.outcome !== 'completed') {
      throw new ServerError(completion.reason || 'fal.ai SeedVR2 upscale failed', { status: 502, code: 'FAL_UPSCALE_FAILED' });
    }

    videoGenEvents.emit('progress', { generationId: jobId, progress: 0.85, status: 'Downloading upscaled clip…' });
    const payload = await readCompletedFalResult(receipt.response_url, {
      apiKey,
      signal: entry.controller.signal,
      deadline,
      label: 'SeedVR2 result retrieval',
    });
    const outUrl = payload?.video?.url || payload?.output?.url || payload?.url;
    if (typeof outUrl !== 'string' || !outUrl) {
      throw new ServerError('fal.ai SeedVR2 returned no output video URL', { status: 502, code: 'FAL_UPSCALE_FAILED' });
    }

    const rawBytes = await readCompletedFalResult(outUrl, {
      signal: entry.controller.signal,
      deadline,
      binary: true,
      binaryTimeoutMs: FAL_UPSCALE_DOWNLOAD_TIMEOUT_MS,
      label: 'SeedVR2 video download',
    });

    const rawPath = join(tmpdir(), `portos-fal-upscale-${jobId}.mp4`);
    scratch.push(rawPath);
    await writeFile(rawPath, Buffer.from(rawBytes));

    const outStream = await probeVideoStreamInfo(rawPath);
    const outWidth = outStream.width;
    const outHeight = outStream.height;
    const outFrames = sourceStream.frameCount ?? outStream.frameCount;

    const newId = randomUUID();
    const newFilename = `${newId}.mp4`;
    const deliverablePath = join(PATHS.videos, newFilename);
    unpublishedPath = deliverablePath;

    const finalized = await finalizeUpscaleOutput(rawPath, deliverablePath, {
      width: outWidth,
      height: outHeight,
      frameCount: outFrames,
      audioSourcePath: sourcePath,
      signal: entry.controller.signal,
    });
    if (!finalized.ok) {
      throw new ServerError(`Failed to finish the upscaled clip: ${finalized.reason}`, { status: 500, code: 'UPSCALE_MUX_FAILED' });
    }

    unpublishedPath = null;
    result = await publishUpscaledVideo({
      jobId, newId, newFilename, deliverablePath, item, musicVideo, renderStartedAtMs,
      isCanceled: () => entry.aborted,
      buildFields: measured => {
        const width = measured.width ?? outWidth;
        const height = measured.height ?? outHeight;
        const numFrames = measured.frameCount ?? outFrames;
        return {
          modelId: FAL_SEEDVR2_HISTORY_MODEL_ID,
          resolution: targetResolution,
          width,
          height,
          fps: measured.fps ?? sourceStream.fps ?? outStream.fps,
          numFrames,
          estimatedCostUsd: estimateFalSeedvr2CostUsd({ width, height, frameCount: numFrames }),
          falRequestId: receipt.request_id,
          upscaleMethod: 'fal-seedvr2',
          upscaleRuntime: FAL_SEEDVR2_RUNTIME_ID,
          prompt: upscaledPrompt(item.prompt, targetResolution),
        };
      },
      formatSuccessLog: row => `✅ Upscaled [${newId.slice(0, 8)}] on fal-seedvr2: ${newFilename} (${row.width}×${row.height}, $${row.estimatedCostUsd ?? '?'}, ${Math.round((row.renderMs ?? 0) / 1000)}s)`,
    });
  } catch (err) {
    await removeOwnedUpscaleFile(jobId, unpublishedPath);
    const reason = entry.aborted ? 'Canceled while running' : (err?.message || 'Upscale failed');
    if (entry.aborted) console.log(`🛑 Video upscale canceled [${jobId.slice(0, 8)}]`);
    else console.error(`❌ Video upscale failed [${jobId.slice(0, 8)}]: ${reason}`);
    failureReason = reason;
  } finally {
    for (const path of scratch) await removeOwnedUpscaleFile(jobId, path);
    activeUpscales.delete(jobId);
  }

  if (failureReason) videoGenEvents.emit('failed', { generationId: jobId, error: failureReason });
  else videoGenEvents.emit('completed', { generationId: jobId, ...result });
  return result;
}
