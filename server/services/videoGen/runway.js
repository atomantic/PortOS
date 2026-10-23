/**
 * Video Gen — Runway developer API provider.
 *
 * A cloud lane like `videoGen/fal.js`: the same job-map/SSE contract, so
 * `mediaJobQueue` dispatches to it on `params.mode === 'runway'`. Flow: POST
 * the start frame (and an optional last frame) as data URIs to
 * `/v1/image_to_video` — or just the prompt to `/v1/text_to_video` when no frame
 * is given and the model renders from text — poll the task until it SUCCEEDS, download `output[0]`
 * and hand it to the shared `finalizeGeneratedVideo` helper.
 *
 * The request body is built per model from the curated catalog
 * (lib/runwayVideoModels.js). Unlike fal, a model id outside the catalog is
 * refused: Runway validates every field per model, so there is no legacy body
 * that would render on an unknown model.
 */

import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { randomUUID } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { join, relative, resolve, isAbsolute } from 'path';
import sharp from 'sharp';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, buildRunwayVideoRequest } from '../../lib/runwayVideoModels.js';
import { getRunwaySpecialVideoModel, buildRunwaySpecialVideoRequest } from '../../lib/runwaySpecialVideoModels.js';
import { validateRunwayVideoInput } from './runwayVideoInputs.js';
import { probeVideoGeometry } from '../../lib/ffmpeg.js';
import { attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { discardUnpublishedVideo, finalizeGeneratedVideo, emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { mutateVideoHistory } from './history.js';
import { getSettings } from '../settings.js';
import { frameDataUriAtAspect } from './falFrameAspect.js';
import {
  awaitRunwayTask, cancelRunwayTask, createRunwayTaskEntry, resolveRunwayApiKey, submitRunwayTask, uploadRunwayVideo,
} from '../runwayApi.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

export { resolveRunwayApiKey };

const RUNWAY_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Runway queues a task behind the account's concurrency limit (THROTTLED), so
// the render budget is generous, the same order as fal's.
const RUNWAY_RENDER_TIMEOUT_MS = (() => {
  const n = Number(process.env.RUNWAY_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();
// Runway takes an inline image of at most 5 MB as an encoded data URI.
const RUNWAY_DATA_URI_MAX_BYTES = 5 * 1024 * 1024;
const RUNWAY_FRAME_MAX_SIDE = 2048;

const jobs = new Map();
const activeRequests = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

const preparations = createMediaJobPreparation();

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error('videoGen/runway.cancel requires a jobId — use cancelAll() to terminate every in-flight render');
  }
  const pending = preparations.cancel(jobId);
  if (pending) return pending;
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.controller.abort();
  void cancelRunwayTask(entry);
  return true;
};

export const cancelAll = () => {
  const ids = [...preparations.ids(), ...activeRequests.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

/**
 * Dry-run the request body with placeholder frames before anything is read or
 * paid for: a missing input or an over-cap prompt refuses here as a 400. Returns
 * the plan and the record of the text Runway receives (#11317); the Video Gen
 * form's preview calls it with the same inputs.
 */
export function runwayVideoSentPrompt({ hasImage = false, hasEndImage = false, hasVideo = false, hasCharacterVideo = false, promptAdditions = [], ...spec }) {
  let planned;
  try {
    const build = getRunwaySpecialVideoModel(spec.modelId) ? buildRunwaySpecialVideoRequest : buildRunwayVideoRequest;
    planned = build({
      ...spec,
      videoUri: hasVideo ? 'pending:video' : null,
      characterVideoUri: hasCharacterVideo ? 'pending:character-video' : null,
      imageUri: hasImage ? 'pending:image' : null,
      endImageUri: hasEndImage ? 'pending:end-image' : null,
    });
  } catch (err) {
    if (err?.code !== 'RUNWAY_MODEL_INPUT') throw err;
    throw new ServerError(err.message, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const record = sentPromptRecord({
    sentPrompt: planned.body.promptText ?? '',
    sentNegativePrompt: planned.body.negativePrompt ?? null,
    carried: carriedPromptAdditions({ promptAdditions }),
    added: [planned.model.negativePrompt ? null : promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', spec.negativePrompt)],
  });
  return { planned, record };
}

/**
 * A frame as a data URI Runway accepts: cropped to the project's aspect when
 * one is named (see falFrameAspect.js), then, only if the encoded URI would
 * pass Runway's 5 MB inline limit, re-encoded as a high-quality JPEG no larger
 * than 2048px on its long side. Returns `{ dataUri, conformed, reencoded }`.
 */
async function runwayFrameDataUri(filePath, aspect) {
  const framed = await frameDataUriAtAspect(filePath, aspect);
  if (Buffer.byteLength(framed.dataUri) <= RUNWAY_DATA_URI_MAX_BYTES) return { ...framed, reencoded: null };
  const source = Buffer.from(framed.dataUri.slice(framed.dataUri.indexOf(',') + 1), 'base64');
  const buffer = await sharp(source)
    .resize(RUNWAY_FRAME_MAX_SIDE, RUNWAY_FRAME_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();
  const dataUri = `data:image/jpeg;base64,${buffer.toString('base64')}`;
  if (Buffer.byteLength(dataUri) > RUNWAY_DATA_URI_MAX_BYTES) {
    throw new Error('The frame is still over Runway\'s 5 MB inline limit after re-encoding');
  }
  return { ...framed, dataUri, reencoded: 'jpeg' };
}

export const generateVideo = (params) => preparations.run(params, generateVideoPrepared);

async function generateVideoPrepared({
  apiKey: providedApiKey, settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height,
  sourceImagePath = null, lastImagePath = null, jobId: providedJobId = null,
  uploadedTempPath = null, uploadedTempPaths = [], audioFilePath = null,
  resolution = null, seed, frameAspect = null, shotInstruction = null, promptAdditions = [],
  videoMode, runwayVideoPath = null, runwayCharacterVideoPath = null, targetAspectRatio, ratio, bodyControl, expressionIntensity,
}) {
  await ensureDir(PATHS.videos);
  const renderStartedAtMs = Date.now();
  if (audioFilePath) {
    throw new ServerError('Runway renders cutaways only; it takes no source audio', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const modelId = requestedModelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL;
  const special = getRunwaySpecialVideoModel(modelId);
  if (!special && (runwayVideoPath || runwayCharacterVideoPath)) throw new ServerError('This Runway model does not take video inputs.', { status: 400, code: 'VALIDATION_ERROR' });
  const effectiveSettings = settings || (providedApiKey ? null : await getSettings().catch(() => null));
  // Re-resolved from live settings, never threaded through persisted job params.
  const apiKey = providedApiKey || resolveRunwayApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError('No Runway API key configured — set it in Settings → Video Gen (or the RUNWAYML_API_SECRET env var)', { status: 400, code: 'RUNWAY_NOT_CONFIGURED' });
  }
  const requestSpec = {
    modelId, prompt, negativePrompt, seconds: duration, aspectRatio: frameAspect || aspectRatio, width, height, resolution,
    videoMode, targetAspectRatio, ratio, bodyControl, expressionIntensity,
    ...(Number.isInteger(seed) ? { seed } : {}),
  };
  const { planned, record: sentRecord } = runwayVideoSentPrompt({
    ...requestSpec, promptAdditions, hasImage: !!sourceImagePath, hasEndImage: !!lastImagePath, hasVideo: !!runwayVideoPath, hasCharacterVideo: !!runwayCharacterVideoPath,
  });

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const meta = {
    id: jobId,
    prompt: (prompt || '').trim(),
    negativePrompt: negativePrompt || '',
    modelId: `runway:${planned.model.id}`,
    duration: planned.seconds,
    ...(planned.body.ratio ? { aspectRatio: planned.body.ratio } : {}),
    ...(planned.resolution ? { resolution: planned.resolution } : {}),
    // What PortOS expected this render to cost at Runway's list price.
    estimatedCostUsd: planned.estimatedCostUsd,
    ...sentRecord,
    filename,
    createdAt: new Date().toISOString(),
    mode: special?.mode || (sourceImagePath ? 'image' : 'text'),
    ...(shotInstruction?.audioWindow ? { audioWindow: shotInstruction.audioWindow } : {}),
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  const costNote = meta.estimatedCostUsd != null ? ` ~$${meta.estimatedCostUsd.toFixed(2)}` : ' cost unknown';
  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] runway (${planned.model.id}${meta.resolution ? ` ${meta.resolution}` : ''}${costNote})`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Submitting to Runway…');

  runRunwayVideo(job, jobId, {
    apiKey, requestSpec, sourceImagePath, lastImagePath, outputPath, filename, meta,
    uploadedTempPath, uploadedTempPaths, frameAspect,
    runwayVideoPath, runwayCharacterVideoPath,
  }).catch((err) => {
    console.error(`❌ Runway video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/videos/${filename}`, generationId: jobId,
    mode: 'runway',
    status: 'running',
  };
}

const isStagedUpload = (path) => {
  const rel = relative(PATHS.uploads, resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

async function downloadRunwayOutput(url, signal) {
  const res = await fetchWithTimeout(url, { signal }, RUNWAY_DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => {});
    throw new Error(`Runway video download failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function runRunwayVideo(job, jobId, {
  apiKey, requestSpec, sourceImagePath, lastImagePath, outputPath, filename, meta,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null,
  runwayVideoPath = null, runwayCharacterVideoPath = null,
}) {
  const entry = createRunwayTaskEntry(apiKey);
  entry.aborted = preparations.take(jobId);
  const publication = {};
  let inputCleanup;
  const settleInputs = () => (inputCleanup ??= (async () => {
    const inputs = new Set([uploadedTempPath, ...(Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [])]);
    for (const path of inputs) {
      if (!path || !isStagedUpload(path)) continue;
      await unlink(path).catch((error) => {
        if (error.code === 'ENOENT') return;
        maintenance.markCurrentUnsettled();
        maintenance.markResourceUnsettled('media', jobId);
        console.error(`❌ Runway staged-input cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
      });
    }
  })());
  const finishFailure = async (reason) => {
    await settleInputs();
    if (entry.aborted) return finalizeCanceled(job, jobId);
    return finalizeJobFailure(job, jobId, null, reason, { force: true });
  };
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + RUNWAY_RENDER_TIMEOUT_MS;
  try {
    if (entry.aborted) return finishFailure('Canceled');
    const special = getRunwaySpecialVideoModel(requestSpec.modelId);
    if (special) {
      const geometry = await validateRunwayVideoInput(runwayVideoPath, special);
      if (runwayCharacterVideoPath) await validateRunwayVideoInput(runwayCharacterVideoPath, special, { character: true });
      meta.duration = geometry.durationSec;
      job.duration = geometry.durationSec;
    }
    const frame = sourceImagePath ? await runwayFrameDataUri(sourceImagePath, frameAspect) : null;
    const endFrame = lastImagePath ? await runwayFrameDataUri(lastImagePath, frameAspect) : null;
    for (const [label, fit] of [['start', frame], ['end', endFrame]]) {
      if (fit?.conformed) console.log(`✂️ Cropped Runway ${label} frame [${jobId.slice(0, 8)}] ${fit.conformed.from} → ${fit.conformed.to} for ${frameAspect}`);
      if (fit?.reencoded) console.log(`🗜️ Re-encoded Runway ${label} frame [${jobId.slice(0, 8)}] as JPEG to fit the 5 MB inline limit`);
    }
    if (frame?.conformed || endFrame?.conformed) {
      meta.frameConformed = { aspect: frameAspect, ...(frame?.conformed ? { start: frame.conformed } : {}), ...(endFrame?.conformed ? { end: endFrame.conformed } : {}) };
    }
    const videoUri = runwayVideoPath ? await uploadRunwayVideo({ apiKey, filePath: runwayVideoPath, signal: entry.controller.signal }) : null;
    const characterVideoUri = runwayCharacterVideoPath ? await uploadRunwayVideo({ apiKey, filePath: runwayCharacterVideoPath, signal: entry.controller.signal }) : null;
    const build = special ? buildRunwaySpecialVideoRequest : buildRunwayVideoRequest;
    const { body, endpoint } = build({ ...requestSpec, videoUri, characterVideoUri, imageUri: frame?.dataUri ?? null, endImageUri: endFrame?.dataUri ?? null });
    if (entry.aborted) return finishFailure('Canceled');
    entry.taskId = await submitRunwayTask({ apiKey, endpoint, body, signal: entry.controller.signal });

    const polled = await awaitRunwayTask({
      entry, apiKey, deadline, timeoutMs: RUNWAY_RENDER_TIMEOUT_MS,
      onPoll: () => videoGenEvents.emit('activity', { generationId: jobId }),
      onStatus: (status) => (status === 'RUNNING'
        ? emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.RENDER, 'Rendering…')
        : emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, status === 'THROTTLED' ? 'Waiting for a Runway slot…' : 'Queued at Runway…')),
    });
    if (polled.outcome === 'canceled') return finishFailure('Canceled');
    if (polled.outcome === 'failed') return finishFailure(polled.reason);

    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.FETCH, 'Downloading video…');
    const buffer = await withAbortTimeout(RUNWAY_DOWNLOAD_TIMEOUT_MS, (timeoutSignal) => downloadRunwayOutput(
      polled.outputUrl, anyAbortSignal([timeoutSignal, entry.controller.signal]),
    ));
    if (entry.aborted) return finishFailure('Canceled');
    await writeFile(outputPath, buffer);
    if (entry.aborted) {
      await unlink(outputPath);
      return finishFailure('Canceled');
    }
    // Record what Runway actually delivered: the Music Video renderer trims every clip by its measured length.
    const measured = (await probeVideoGeometry(outputPath)) || {};
    activeRequests.delete(jobId);
    await settleInputs();
    activeJobs.delete(jobId);
    await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta: { ...meta, ...measured }, actualSeed: null, mutateHistory: mutateVideoHistory, publication });
    closeJobAfterDelay(jobs, jobId);
  } catch (err) {
    if (!publication.committed) await discardUnpublishedVideo({ jobId, outputPath }).catch((error) => {
      maintenance.markCurrentUnsettled();
      maintenance.markResourceUnsettled('media', jobId);
      console.error(`❌ Runway video publication cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
    });
    await cancelRunwayTask(entry);
    return finishFailure(`Runway video generation failed: ${err?.message || err}`);
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'Runway video generation',
  events: videoGenEvents,
});
const finalizeCanceled = finalizeJobFailure.canceled;
