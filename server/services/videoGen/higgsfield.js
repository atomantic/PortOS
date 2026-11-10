/**
 * Video Gen — Higgsfield developer API provider.
 *
 * Same job-map/SSE contract as `videoGen/fal.js` (cloud lane, no local child
 * process). The chosen family's text, image or reference endpoint is picked by
 * `lib/higgsfieldVideoModels.js` from the inputs; local frames are uploaded to
 * Higgsfield first because the API only reads public URLs. The MP4 goes through
 * the shared `finalizeGeneratedVideo`, like every other backend.
 *
 * Money: every submit is billed, and Higgsfield can only cancel a request that
 * has not started. The key is resolved from live settings at dispatch and
 * never rides in persisted queue params.
 */

import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { randomUUID } from 'crypto';
import { readFile, writeFile, unlink } from 'fs/promises';
import { basename, join, relative, resolve, isAbsolute } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { HIGGSFIELD_DEFAULT_VIDEO_MODEL, buildHiggsfieldVideoRequest, getHiggsfieldVideoModel } from '../../lib/higgsfieldVideoModels.js';
import { probeVideoGeometry } from '../../lib/ffmpeg.js';
import { attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { discardUnpublishedVideo, finalizeGeneratedVideo, emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { mutateVideoHistory } from './history.js';
import { getSettings } from '../settings.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
import { frameDataUriAtAspect } from './falFrameAspect.js';
import {
  awaitHiggsfieldRequest, cancelHiggsfieldRequest, createHiggsfieldRequestEntry, resolveHiggsfieldApiKey,
  submitHiggsfieldRequest, uploadHiggsfieldFile,
} from '../higgsfieldApi.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

const HIGGSFIELD_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const HIGGSFIELD_RENDER_TIMEOUT_MS = (() => {
  const n = Number(process.env.HIGGSFIELD_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
})();

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
    throw new Error('videoGen/higgsfield.cancel requires a jobId — use cancelAll() to terminate every in-flight render');
  }
  const pending = preparations.cancel(jobId);
  if (pending) return pending;
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.controller.abort();
  void cancelHiggsfieldRequest(entry);
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
 * for: an unsupported input combination or an over-limit prompt refuses here
 * as a 400. Returns the plan and the record of the text Higgsfield receives
 * (#11317); the Video Gen preview calls it with the same inputs.
 */
export function higgsfieldVideoSentPrompt({
  hasImage = false, hasEndImage = false, referenceCount = 0, hasAudio = false, promptAdditions = [], ...spec
}) {
  let planned;
  try {
    planned = buildHiggsfieldVideoRequest({
      ...spec,
      modelId: spec.modelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL,
      audioUrls: hasAudio ? ['pending:audio'] : [],
      imageUrl: hasImage ? 'pending:image' : null,
      endImageUrl: hasEndImage ? 'pending:end-image' : null,
      referenceImageUrls: Array.from({ length: referenceCount }, (_, i) => `pending:reference-${i + 1}`),
    });
  } catch (err) {
    throw new ServerError(err.message, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const record = sentPromptRecord({
    sentPrompt: planned.body.prompt ?? '',
    carried: carriedPromptAdditions({ promptAdditions }),
    added: [promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', spec.negativePrompt)],
  });
  return { planned, record };
}

export const generateVideo = (params) => preparations.run(params, generateVideoPrepared);

async function generateVideoPrepared({
  apiKey: providedApiKey, settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height, resolution = null, generateAudio = false, seed = null,
  sourceImagePath = null, lastImagePath = null, referenceImagePaths = [], audioFilePath = null, jobId: providedJobId = null,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null, promptAdditions = [],
}) {
  await ensureDir(PATHS.videos);
  const renderStartedAtMs = Date.now();
  const modelId = requestedModelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL;
  if (!getHiggsfieldVideoModel(modelId)) {
    throw new ServerError(`"${modelId}" is not a Higgsfield video model PortOS offers`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const effectiveSettings = settings || (providedApiKey ? null : await getSettings().catch(() => null));
  const apiKey = providedApiKey || resolveHiggsfieldApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError('No Higgsfield credential configured — add it in Settings → Credentials or set HIGGSFIELD_API_KEY', { status: 400, code: 'HIGGSFIELD_NOT_CONFIGURED' });
  }
  const spec = {
    modelId, prompt, negativePrompt, seconds: duration, resolution, width, height, aspectRatio: aspectRatio || frameAspect,
    generateAudio: generateAudio === true, seed,
  };
  const { planned, record: sentRecord } = higgsfieldVideoSentPrompt({
    ...spec, promptAdditions, hasAudio: !!audioFilePath, hasImage: !!sourceImagePath, hasEndImage: !!lastImagePath, referenceCount: referenceImagePaths.length,
  });

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const meta = {
    id: jobId,
    prompt: (prompt || '').trim(),
    negativePrompt: negativePrompt || '',
    modelId: `higgsfield:${planned.endpointId}`,
    duration: planned.seconds,
    ...(planned.body.aspect_ratio ? { aspectRatio: planned.body.aspect_ratio } : {}),
    ...(planned.resolution ? { resolution: planned.resolution } : {}),
    ...(planned.model.audio ? { generateAudio: planned.generateAudio } : {}),
    ...(planned.body.seed != null ? { seed: planned.body.seed } : {}),
    estimatedCostUsd: null,
    ...sentRecord,
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
    ...(referenceImagePaths.length ? { clipReferenceFiles: referenceImagePaths.map((path) => basename(path)) } : {}),
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] Higgsfield (${planned.endpointId}${meta.resolution ? ` ${meta.resolution}` : ''} ${planned.seconds}s)`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Submitting to Higgsfield…');

  runHiggsfieldVideo(job, jobId, {
    apiKey, spec, sourceImagePath, lastImagePath, referenceImagePaths, audioFilePath, outputPath, filename, meta,
    uploadedTempPath, uploadedTempPaths, frameAspect,
  }).catch((err) => {
    console.error(`❌ Higgsfield video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return { jobId, filename, path: `/data/videos/${filename}`, generationId: jobId, mode: 'higgsfield', status: 'running' };
}

const isStagedUpload = (path) => {
  const rel = relative(PATHS.uploads, resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

// A frame is cropped to the project's aspect (Music Video) before upload, like the fal lane.
async function uploadFrame({ apiKey, path, aspect, signal }) {
  const { dataUri, conformed } = await frameDataUriAtAspect(path, aspect);
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
  if (!match || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(match[1])) {
    throw new ServerError('Higgsfield accepts PNG, JPEG, WebP or GIF frames', { status: 400, code: 'HIGGSFIELD_INPUT_INVALID' });
  }
  const url = await uploadHiggsfieldFile({ apiKey, bytes: Buffer.from(match[2], 'base64'), contentType: match[1], signal });
  return { url, conformed };
}

async function runHiggsfieldVideo(job, jobId, {
  apiKey, spec, sourceImagePath, lastImagePath, referenceImagePaths, audioFilePath, outputPath, filename, meta,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null,
}) {
  const entry = createHiggsfieldRequestEntry(apiKey);
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
        console.error(`❌ Higgsfield staged-input cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
      });
    }
  })());
  const finishFailure = async (reason) => {
    await settleInputs();
    if (entry.aborted) return finalizeCanceled(job, jobId);
    return finalizeJobFailure(job, jobId, null, reason, { force: true });
  };
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + HIGGSFIELD_RENDER_TIMEOUT_MS;
  try {
    const signal = entry.controller.signal;
    const start = sourceImagePath ? await uploadFrame({ apiKey, path: sourceImagePath, aspect: frameAspect, signal }) : null;
    const end = lastImagePath ? await uploadFrame({ apiKey, path: lastImagePath, aspect: frameAspect, signal }) : null;
    if (start?.conformed || end?.conformed) {
      meta.frameConformed = { aspect: frameAspect, ...(start?.conformed ? { start: start.conformed } : {}), ...(end?.conformed ? { end: end.conformed } : {}) };
    }
    // References are not frames of the clip, so they go in uncropped.
    const referenceImageUrls = [];
    for (const path of referenceImagePaths) referenceImageUrls.push((await uploadFrame({ apiKey, path, aspect: null, signal })).url);
    if (entry.aborted) return finishFailure('Canceled');
    const audioUrls = audioFilePath ? [await uploadHiggsfieldFile({ apiKey, bytes: await readFile(audioFilePath), contentType: 'audio/wav', signal })] : [];
    const request = buildHiggsfieldVideoRequest({ ...spec, imageUrl: start?.url ?? null, endImageUrl: end?.url ?? null, referenceImageUrls, audioUrls });
    meta.sentRequest = { endpoint: request.endpointId, body: structuredClone(request.body) };
    Object.assign(job, { sentRequest: meta.sentRequest });
    const submitted = await submitHiggsfieldRequest({ apiKey, endpoint: request.endpointId, body: request.body, signal });
    entry.requestId = submitted.requestId;
    entry.cancelUrl = submitted.cancelUrl;
    meta.higgsfieldRequestId = submitted.requestId;

    const polled = await awaitHiggsfieldRequest({
      entry, apiKey, statusUrl: submitted.statusUrl, kind: 'video', deadline, timeoutMs: HIGGSFIELD_RENDER_TIMEOUT_MS,
      onPoll: () => videoGenEvents.emit('activity', { generationId: jobId }),
      onStatus: (status) => (status === 'in_progress'
        ? emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.RENDER, 'Rendering…')
        : emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Queued at Higgsfield…')),
    });
    if (polled.outcome === 'canceled') return finishFailure('Canceled');
    if (polled.outcome === 'failed') return finishFailure(polled.reason);

    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.FETCH, 'Downloading video…');
    const buffer = await withAbortTimeout(HIGGSFIELD_DOWNLOAD_TIMEOUT_MS, async (timeoutSignal) => {
      const downloadSignal = anyAbortSignal([timeoutSignal, signal]);
      const response = await fetchWithTimeout(polled.outputUrl, { signal: downloadSignal }, HIGGSFIELD_DOWNLOAD_TIMEOUT_MS);
      if (!response.ok) throw new Error(`Higgsfield video download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    });
    if (entry.aborted) return finishFailure('Canceled');
    await writeFile(outputPath, buffer);
    if (entry.aborted) {
      await unlink(outputPath);
      return finishFailure('Canceled');
    }
    const measured = (await probeVideoGeometry(outputPath)) || {};
    activeRequests.delete(jobId);
    await settleInputs();
    activeJobs.delete(jobId);
    await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta: { ...meta, ...measured }, actualSeed: request.body.seed ?? null, mutateHistory: mutateVideoHistory, publication });
    closeJobAfterDelay(jobs, jobId);
    void autoDeleteHostedCopy('higgsfield', 'video', jobId, { apiKey });
  } catch (err) {
    if (!publication.committed) await discardUnpublishedVideo({ jobId, outputPath }).catch(error => {
      maintenance.markCurrentUnsettled();
      maintenance.markResourceUnsettled('media', jobId);
      console.error(`❌ Higgsfield video publication cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
    });
    await cancelHiggsfieldRequest(entry);
    return finishFailure(`Higgsfield video generation failed: ${err?.message || err}`);
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'Higgsfield video generation',
  events: videoGenEvents,
});
const finalizeCanceled = finalizeJobFailure.canceled;
