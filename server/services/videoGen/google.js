/**
 * Video Gen — Google Cloud Agent Platform Veo provider.
 *
 * Same job-map/SSE contract as `videoGen/higgsfield.js` (cloud lane, no local
 * child process). `lib/googleVideoModels.js` builds the one predictLongRunning
 * instance from the inputs (prompt, start frame, end frame or asset reference
 * images, all inline base64); `services/googleCloudApi.js` submits and polls it.
 * The MP4 comes back inline and goes through the shared `finalizeGeneratedVideo`.
 *
 * Money: every submit is billed and Google cannot cancel a Veo operation, so a
 * canceled render is marked unsettled. The credential is resolved from live
 * settings at dispatch and never rides in persisted queue params.
 */

import { basename } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { GOOGLE_DEFAULT_VIDEO_MODEL, buildGoogleVideoRequest, getGoogleVideoModel } from '../../lib/googleVideoModels.js';
import { videoGenEvents } from './events.js';
import { emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { createHostedVideoJobRunner } from './hostedJobRunner.js';
import { getSettings } from '../settings.js';
import { frameDataUriAtAspect } from './falFrameAspect.js';
import {
  abandonGoogleOperation, awaitGoogleOperation, createGoogleOperationEntry, resolveGoogleConfig, submitGoogleOperation, googleExpressModeRefusal,
  googleFilteredReason, googleInlineImage,
} from '../googleCloudApi.js';
import { carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';

const GOOGLE_RENDER_TIMEOUT_MS = (() => {
  const n = Number(process.env.GOOGLE_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
})();
const PLACEHOLDER_IMAGE = Object.freeze({ mimeType: 'image/png', data: '' });

// Veo operations cannot be canceled remotely: a cancel stops the wait, and a
// failure marks the spend unsettled (abandonGoogleOperation).
const runner = createHostedVideoJobRunner({ mode: 'google', provider: 'Google', abandonRemote: abandonGoogleOperation });
export const { getActiveJob, attachSseClient, cancel, cancelAll } = runner;

/**
 * Dry-run the request with placeholder media before anything is read or paid
 * for: an unsupported input combination refuses here as a 400. Returns the plan
 * and the record of the text Veo receives (#11317); the Video Gen preview calls
 * it with the same inputs.
 */
export function googleVideoSentPrompt({
  hasImage = false, hasEndImage = false, referenceCount = 0, promptAdditions = [], ...spec
}) {
  let planned;
  try {
    planned = buildGoogleVideoRequest({
      ...spec,
      modelId: spec.modelId || GOOGLE_DEFAULT_VIDEO_MODEL,
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

export const generateVideo = (params) => runner.prepare(params, generateVideoPrepared);

async function generateVideoPrepared({
  settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height, resolution = null, generateAudio = false, seed = null,
  sourceImagePath = null, lastImagePath = null, referenceImagePaths = [], jobId,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null, promptAdditions = [],
}) {
  await ensureDir(PATHS.videos);
  const renderStartedAtMs = Date.now();
  const modelId = requestedModelId || GOOGLE_DEFAULT_VIDEO_MODEL;
  if (!getGoogleVideoModel(modelId)) {
    throw new ServerError(`"${modelId}" is not a Google video model PortOS offers`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const config = resolveGoogleConfig(settings || await getSettings().catch(() => null));
  if (!config) {
    throw new ServerError('No Google credential configured — add it in Settings → Credentials (Google Cloud (Agent Platform)) or set GOOGLE_CLOUD_API_KEY', { status: 400, code: 'GOOGLE_NOT_CONFIGURED' });
  }
  // No Veo model is on the express-mode list.
  const expressRefusal = googleExpressModeRefusal(config, getGoogleVideoModel(modelId));
  if (expressRefusal) throw new ServerError(expressRefusal, { status: 400, code: 'GOOGLE_PROJECT_REQUIRED' });
  const spec = {
    modelId, prompt, negativePrompt, seconds: duration, resolution, width, height, aspectRatio: aspectRatio || frameAspect,
    generateAudio: generateAudio === true, seed,
  };
  const { planned, record: sentRecord } = googleVideoSentPrompt({
    ...spec, promptAdditions, hasImage: !!sourceImagePath, hasEndImage: !!lastImagePath, referenceCount: referenceImagePaths.length,
  });

  const filename = `${jobId}.mp4`;
  const meta = {
    id: jobId,
    prompt: (prompt || '').trim(),
    negativePrompt: negativePrompt || '',
    modelId: `google:${modelId}`,
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
  return runner.start({
    meta, renderStartedAtMs, logDetail: `${modelId} ${planned.resolution} ${planned.seconds}s`,
    run: (job) => runGoogleVideo(job, jobId, {
      config, spec, sourceImagePath, lastImagePath, referenceImagePaths, meta,
      uploadedTempPath, uploadedTempPaths, frameAspect,
    }),
  });
}

// A frame is cropped to the project's aspect (Music Video) before it is sent, like the fal lane.
async function inlineFrame(path, aspect) {
  const { dataUri, conformed } = await frameDataUriAtAspect(path, aspect);
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(dataUri);
  if (!match) throw new ServerError('Google accepts PNG, JPEG or WebP frames', { status: 400, code: 'GOOGLE_INPUT_INVALID' });
  return { image: googleInlineImage(Buffer.from(match[1], 'base64')), conformed };
}

async function runGoogleVideo(job, jobId, {
  config, spec, sourceImagePath, lastImagePath, referenceImagePaths, meta,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null,
}) {
  const { entry, finishFailure, publish, fail } = runner.begin(job, createGoogleOperationEntry(), {
    inputs: [uploadedTempPath, ...(Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [])],
  });
  const deadline = Date.now() + GOOGLE_RENDER_TIMEOUT_MS;
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
    const request = buildGoogleVideoRequest({ ...spec, image: start?.image ?? null, lastImage: end?.image ?? null, referenceImages });
    entry.operationName = await submitGoogleOperation(config, spec.modelId, request.body, { signal });
    meta.googleOperationName = entry.operationName;

    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.RENDER, 'Rendering on Google…');
    const polled = await awaitGoogleOperation({
      entry, config, modelId: spec.modelId, deadline, timeoutMs: GOOGLE_RENDER_TIMEOUT_MS,
      onPoll: () => videoGenEvents.emit('activity', { generationId: jobId }),
    });
    if (polled.outcome === 'canceled') return finishFailure('Canceled');
    if (polled.outcome === 'failed') return finishFailure(polled.reason);

    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.FETCH, 'Saving video…');
    const video = Array.isArray(polled.response?.videos) ? polled.response.videos.find((v) => typeof v?.bytesBase64Encoded === 'string') : null;
    if (!video) return finishFailure(googleFilteredReason(polled.response, 'video'));
    await publish({ buffer: Buffer.from(video.bytesBase64Encoded, 'base64'), meta, actualSeed: request.seed ?? null });
  } catch (err) {
    return fail(err);
  }
}
