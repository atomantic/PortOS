/**
 * Video Gen — Google Cloud Vertex AI Veo provider.
 *
 * Same job-map/SSE contract as `videoGen/higgsfield.js` (cloud lane, no local
 * child process). `lib/vertexVideoModels.js` builds the one predictLongRunning
 * instance from the inputs (prompt, start frame, end frame or asset reference
 * images, all inline base64); `services/vertexApi.js` submits and polls it.
 * The MP4 comes back inline and goes through the shared `finalizeGeneratedVideo`.
 *
 * Money: every submit is billed and Vertex cannot cancel a Veo operation, so a
 * canceled render is marked unsettled. The credential is resolved from live
 * settings at dispatch and never rides in persisted queue params.
 */

import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { randomUUID } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { basename, join, relative, resolve, isAbsolute } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { VERTEX_DEFAULT_VIDEO_MODEL, buildVertexVideoRequest, getVertexVideoModel } from '../../lib/vertexVideoModels.js';
import { probeVideoGeometry } from '../../lib/ffmpeg.js';
import { attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { discardUnpublishedVideo, finalizeGeneratedVideo, emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { mutateVideoHistory } from './history.js';
import { getSettings } from '../settings.js';
import { frameDataUriAtAspect } from './falFrameAspect.js';
import {
  abandonVertexOperation, awaitVertexOperation, createVertexOperationEntry, resolveVertexConfig, submitVertexOperation,
  vertexFilteredReason, vertexInlineImage,
} from '../vertexApi.js';
import { carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';

const VERTEX_RENDER_TIMEOUT_MS = (() => {
  const n = Number(process.env.VERTEX_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
})();
const PLACEHOLDER_IMAGE = Object.freeze({ mimeType: 'image/png', data: '' });

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
    throw new Error('videoGen/vertex.cancel requires a jobId — use cancelAll() to terminate every in-flight render');
  }
  const pending = preparations.cancel(jobId);
  if (pending) return pending;
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.controller.abort();
  return true;
};

export const cancelAll = () => {
  const ids = [...preparations.ids(), ...activeRequests.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

/**
 * Dry-run the request with placeholder media before anything is read or paid
 * for: an unsupported input combination refuses here as a 400. Returns the plan
 * and the record of the text Veo receives (#11317); the Video Gen preview calls
 * it with the same inputs.
 */
export function vertexVideoSentPrompt({
  hasImage = false, hasEndImage = false, referenceCount = 0, promptAdditions = [], ...spec
}) {
  let planned;
  try {
    planned = buildVertexVideoRequest({
      ...spec,
      modelId: spec.modelId || VERTEX_DEFAULT_VIDEO_MODEL,
      image: hasImage ? PLACEHOLDER_IMAGE : null,
      lastImage: hasEndImage ? PLACEHOLDER_IMAGE : null,
      referenceImages: Array.from({ length: referenceCount }, () => PLACEHOLDER_IMAGE),
    });
  } catch (err) {
    throw new ServerError(err.message, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const instance = planned.body.instances[0];
  const record = sentPromptRecord({
    sentPrompt: instance.prompt ?? '',
    sentNegativePrompt: planned.body.parameters.negativePrompt ?? null,
    carried: carriedPromptAdditions({ promptAdditions }),
  });
  return { planned, record };
}

export const generateVideo = (params) => preparations.run(params, generateVideoPrepared);

async function generateVideoPrepared({
  settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height, resolution = null, generateAudio = false, seed = null,
  sourceImagePath = null, lastImagePath = null, referenceImagePaths = [], jobId: providedJobId = null,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null, promptAdditions = [],
}) {
  await ensureDir(PATHS.videos);
  const renderStartedAtMs = Date.now();
  const modelId = requestedModelId || VERTEX_DEFAULT_VIDEO_MODEL;
  if (!getVertexVideoModel(modelId)) {
    throw new ServerError(`"${modelId}" is not a Vertex AI video model PortOS offers`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const config = resolveVertexConfig(settings || await getSettings().catch(() => null));
  if (!config) {
    throw new ServerError('No Vertex AI credential configured — add it in Settings → Credentials (Google Vertex AI) or set VERTEX_API_KEY', { status: 400, code: 'VERTEX_NOT_CONFIGURED' });
  }
  const spec = {
    modelId, prompt, negativePrompt, seconds: duration, resolution, width, height, aspectRatio: aspectRatio || frameAspect,
    generateAudio: generateAudio === true, seed,
  };
  const { planned, record: sentRecord } = vertexVideoSentPrompt({
    ...spec, promptAdditions, hasImage: !!sourceImagePath, hasEndImage: !!lastImagePath, referenceCount: referenceImagePaths.length,
  });

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const meta = {
    id: jobId,
    prompt: (prompt || '').trim(),
    negativePrompt: negativePrompt || '',
    modelId: `vertex:${modelId}`,
    duration: planned.seconds,
    ...(planned.aspectRatio ? { aspectRatio: planned.aspectRatio } : {}),
    resolution: planned.resolution,
    generateAudio: planned.generateAudio,
    ...(planned.seed != null ? { seed: planned.seed } : {}),
    estimatedCostUsd: null,
    ...sentRecord,
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
    ...(referenceImagePaths.length ? { clipReferenceFiles: referenceImagePaths.map((path) => basename(path)) } : {}),
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] Vertex AI (${modelId} ${planned.resolution} ${planned.seconds}s)`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Submitting to Vertex AI…');

  runVertexVideo(job, jobId, {
    config, spec, sourceImagePath, lastImagePath, referenceImagePaths, outputPath, filename, meta,
    uploadedTempPath, uploadedTempPaths, frameAspect,
  }).catch((err) => {
    console.error(`❌ Vertex AI video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return { jobId, filename, path: `/data/videos/${filename}`, generationId: jobId, mode: 'vertex', status: 'running' };
}

const isStagedUpload = (path) => {
  const rel = relative(PATHS.uploads, resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

// A frame is cropped to the project's aspect (Music Video) before it is sent, like the fal lane.
async function inlineFrame(path, aspect) {
  const { dataUri, conformed } = await frameDataUriAtAspect(path, aspect);
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(dataUri);
  if (!match) throw new ServerError('Vertex AI accepts PNG, JPEG or WebP frames', { status: 400, code: 'VERTEX_INPUT_INVALID' });
  return { image: vertexInlineImage(Buffer.from(match[1], 'base64')), conformed };
}

async function runVertexVideo(job, jobId, {
  config, spec, sourceImagePath, lastImagePath, referenceImagePaths, outputPath, filename, meta,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null,
}) {
  const entry = createVertexOperationEntry();
  entry.aborted = preparations.take(jobId);
  const publication = {};
  let inputCleanup;
  const settleInputs = () => (inputCleanup ??= (async () => {
    const inputs = new Set([uploadedTempPath, ...(Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [])]);
    for (const path of inputs) {
      if (!path || !isStagedUpload(path)) continue;
      await unlink(path).catch(error => {
        if (error.code === 'ENOENT') return;
        maintenance.markCurrentUnsettled();
        maintenance.markResourceUnsettled('media', jobId);
        console.error(`❌ Vertex AI staged-input cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
      });
    }
  })());
  const finishFailure = async (reason) => {
    await settleInputs();
    if (entry.aborted) return finalizeCanceled(job, jobId);
    return finalizeJobFailure(job, jobId, null, reason, { force: true });
  };
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + VERTEX_RENDER_TIMEOUT_MS;
  try {
    const signal = entry.controller.signal;
    const start = sourceImagePath ? await inlineFrame(sourceImagePath, frameAspect) : null;
    const end = lastImagePath ? await inlineFrame(lastImagePath, frameAspect) : null;
    if (start?.conformed || end?.conformed) {
      meta.frameConformed = { aspect: frameAspect, ...(start?.conformed ? { start: start.conformed } : {}), ...(end?.conformed ? { end: end.conformed } : {}) };
    }
    // References are not frames of the clip, so they go in uncropped.
    const referenceImages = [];
    for (const path of referenceImagePaths) referenceImages.push((await inlineFrame(path, null)).image);
    if (entry.aborted) return finishFailure('Canceled');
    const request = buildVertexVideoRequest({ ...spec, image: start?.image ?? null, lastImage: end?.image ?? null, referenceImages });
    entry.operationName = await submitVertexOperation(config, spec.modelId, request.body, { signal });
    meta.vertexOperationName = entry.operationName;

    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.RENDER, 'Rendering on Vertex AI…');
    const polled = await awaitVertexOperation({
      entry, config, modelId: spec.modelId, deadline, timeoutMs: VERTEX_RENDER_TIMEOUT_MS,
      onPoll: () => videoGenEvents.emit('activity', { generationId: jobId }),
    });
    if (polled.outcome === 'canceled') return finishFailure('Canceled');
    if (polled.outcome === 'failed') return finishFailure(polled.reason);

    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.FETCH, 'Saving video…');
    const video = Array.isArray(polled.response?.videos) ? polled.response.videos.find((v) => typeof v?.bytesBase64Encoded === 'string') : null;
    if (!video) return finishFailure(vertexFilteredReason(polled.response, 'video'));
    await writeFile(outputPath, Buffer.from(video.bytesBase64Encoded, 'base64'));
    if (entry.aborted) {
      await unlink(outputPath);
      return finishFailure('Canceled');
    }
    const measured = (await probeVideoGeometry(outputPath)) || {};
    activeRequests.delete(jobId);
    await settleInputs();
    activeJobs.delete(jobId);
    await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta: { ...meta, ...measured }, actualSeed: request.seed ?? null, mutateHistory: mutateVideoHistory, publication });
    closeJobAfterDelay(jobs, jobId);
  } catch (err) {
    if (!publication.committed) await discardUnpublishedVideo({ jobId, outputPath }).catch(error => {
      maintenance.markCurrentUnsettled();
      maintenance.markResourceUnsettled('media', jobId);
      console.error(`❌ Vertex AI video publication cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
    });
    abandonVertexOperation(entry);
    return finishFailure(`Vertex AI video generation failed: ${err?.message || err}`);
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'Vertex AI video generation',
  events: videoGenEvents,
});
const finalizeCanceled = finalizeJobFailure.canceled;
