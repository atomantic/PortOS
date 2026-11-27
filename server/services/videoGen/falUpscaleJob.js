/**
 * Cloud generative video upscale via fal.ai SeedVR2 (`fal-ai/seedvr/upscale/video`).
 *
 * Rides `mediaJobQueue` on the `cloud` lane (`mode: 'fal'`), mirroring
 * `upscaleJob.js` and `fal.js`: the source clip is never modified, a NEW file
 * and NEW history entry are published atomically inside `withBackupAssetPublication`,
 * and `estimatedCostUsd` + `musicVideo` attribution feed directly into Music Video
 * history, takes, collections and `renderSpend` accounting.
 */

import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import { PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { FINISHED_OUTPUT_ADMISSION_MS } from '../../lib/backupPublicationWait.js';
import {
  safeUnder, generateThumbnail, probeVideoStreamInfo, probeVideoDuration,
} from '../../lib/ffmpeg.js';
import { omitDerivedRenderFields, renderTimingFields } from '../../lib/renderTiming.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import {
  awaitFalCompletion, cancelFalRequest, createFalRequestEntry,
  hostFalDataUri, readCompletedFalResult, resolveFalApiKey, submitFalRequest,
} from '../falQueue.js';
import { videoGenEvents } from './events.js';
import { getHistoryItem, mutateVideoHistory } from './history.js';
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

const removeOwnedFile = (path) => (path ? unlinkGuarded(path).catch(() => {}) : Promise.resolve());

/**
 * Validate a fal.ai SeedVR2 upscale request and enqueue it on the cloud lane.
 * Refuses already-upscaled clips or missing `FAL_KEY` before committing a job.
 */
export async function enqueueFalSeedvr2Upscale(historyId, {
  targetResolution = DEFAULT_FAL_SEEDVR2_TARGET_RESOLUTION,
  musicVideoProjectId = null,
  sceneId = null,
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
  const item = await getHistoryItem(historyId);
  const musicVideo = musicVideoProjectId
    ? { projectId: musicVideoProjectId, ...(sceneId ? { sceneId } : {}), tier: 'final' }
    : null;

  return enqueueJob({
    kind: LTX_UPSCALE_JOB_KIND,
    params: {
      mode: 'fal',
      upscaleMethod: 'fal-seedvr2',
      historyId: item.id,
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
      ...(musicVideo ? { musicVideo, musicVideoProjectId: musicVideo.projectId } : {}),
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
  let deliverablePath = null;
  let thumbnailPath = null;
  let result = null;
  let failureReason = null;

  try {
    const item = await getHistoryItem(historyId);
    if (!item?.filename) {
      throw new ServerError('Source video history entry not found', { status: 404, code: 'NOT_FOUND' });
    }
    const sourcePath = safeUnder(PATHS.videos, item.filename);
    if (!sourcePath || !existsSync(sourcePath)) {
      throw new ServerError('Source video file not found on disk', { status: 404, code: 'FILE_NOT_FOUND' });
    }

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
    deliverablePath = join(PATHS.videos, newFilename);

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

    await withBackupAssetPublication(async () => {
      try {
        if (entry.aborted) throw new ServerError('Upscale canceled', { status: 499, code: 'UPSCALE_CANCELED' });
        const [measured, duration] = await Promise.all([
          probeVideoStreamInfo(deliverablePath),
          probeVideoDuration(deliverablePath),
        ]);
        const thumbnail = await generateThumbnail(deliverablePath, newId);
        thumbnailPath = thumbnail ? safeUnder(PATHS.videoThumbnails, thumbnail) : null;
        const width = measured.width ?? outWidth;
        const height = measured.height ?? outHeight;
        const numFrames = measured.frameCount ?? outFrames;
        const estimatedCostUsd = estimateFalSeedvr2CostUsd({ width, height, frameCount: numFrames });
        const attributedMusicVideo = musicVideo?.projectId
          ? { projectId: musicVideo.projectId, ...(musicVideo.sceneId ? { sceneId: musicVideo.sceneId } : {}) }
          : item.musicVideo;

        const newEntry = {
          ...omitDerivedRenderFields(item),
          id: newId,
          filename: newFilename,
          thumbnail,
          createdAt: new Date().toISOString(),
          modelId: FAL_SEEDVR2_HISTORY_MODEL_ID,
          resolution: targetResolution,
          width,
          height,
          fps: measured.fps ?? sourceStream.fps ?? outStream.fps,
          numFrames,
          duration,
          durationSec: duration,
          estimatedCostUsd,
          falRequestId: receipt.request_id,
          upscaledFrom: item.id,
          upscaleMethod: 'fal-seedvr2',
          upscaleRuntime: FAL_SEEDVR2_RUNTIME_ID,
          prompt: upscaledPrompt(item.prompt, targetResolution),
          ...(attributedMusicVideo ? { musicVideo: attributedMusicVideo } : {}),
          hidden: false,
          ...renderTimingFields(renderStartedAtMs),
        };
        await mutateVideoHistory((h) => { h.unshift(newEntry); return h; });
        result = newEntry;
        console.log(`✅ Upscaled [${newId.slice(0, 8)}] on fal-seedvr2: ${newFilename} (${width}×${height}, $${estimatedCostUsd ?? '?'}, ${Math.round((newEntry.renderMs ?? 0) / 1000)}s)`);
      } catch (error) {
        if (!result) for (const path of [deliverablePath, join(PATHS.videoThumbnails, `${newId}.jpg`)]) await removeOwnedFile(path);
        throw error;
      }
    }, {
      timeoutMs: FINISHED_OUTPUT_ADMISSION_MS,
      onWait: () => {
        console.log(`⏸️ Video upscale [${jobId.slice(0, 8)}] waiting for the backup to finish before saving`);
        videoGenEvents.emit('activity', { generationId: jobId });
      },
    });
  } catch (err) {
    for (const path of result ? [] : [deliverablePath, thumbnailPath]) {
      await removeOwnedFile(path);
    }
    const reason = entry.aborted ? 'Canceled while running' : (err?.message || 'Upscale failed');
    console.error(`❌ Video upscale ${entry.aborted ? 'canceled' : 'failed'} [${jobId.slice(0, 8)}]: ${reason}`);
    failureReason = reason;
  } finally {
    for (const path of scratch) await removeOwnedFile(path);
    activeUpscales.delete(jobId);
  }

  if (failureReason) videoGenEvents.emit('failed', { generationId: jobId, error: failureReason });
  else videoGenEvents.emit('completed', { generationId: jobId, ...result });
  return result;
}
