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

import { readFile } from 'fs/promises';
import { basename } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { HIGGSFIELD_DEFAULT_VIDEO_MODEL, HIGGSFIELD_FRAME_ROLE_LINE, buildHiggsfieldVideoRequest, getHiggsfieldVideoModel } from '../../lib/higgsfieldVideoModels.js';
import { videoGenEvents } from './events.js';
import { emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { createHostedVideoJobRunner } from './hostedJobRunner.js';
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

const runner = createHostedVideoJobRunner({ mode: 'higgsfield', provider: 'Higgsfield', cancelRemote: cancelHiggsfieldRequest });
export const { getActiveJob, attachSseClient, cancel, cancelAll } = runner;

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
    added: [
      promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', spec.negativePrompt),
      planned.frameAsReference ? promptAddition('start-frame-role', 'Start frame sent as the first reference', HIGGSFIELD_FRAME_ROLE_LINE) : null,
    ],
  });
  return { planned, record };
}

export const generateVideo = (params) => runner.prepare(params, generateVideoPrepared);

async function generateVideoPrepared({
  apiKey: providedApiKey, settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height, resolution = null, generateAudio = false, seed = null,
  sourceImagePath = null, lastImagePath = null, referenceImagePaths = [], audioFilePath = null, jobId,
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

  const filename = `${jobId}.mp4`;
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
    // The list price of this take (higgsfieldVideoClipQuote), or null for an unlisted tier.
    estimatedCostUsd: planned.estimatedCostUsd,
    ...sentRecord,
    // Which endpoint family carried the take (text / image / reference), so a take can be explained after the fact.
    higgsfieldRoute: planned.route,
    ...(planned.frameAsReference ? { startFrameAsReference: true } : {}),
    ...(planned.silentNotice ? { notice: planned.silentNotice } : {}),
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
    ...(referenceImagePaths.length ? { clipReferenceFiles: referenceImagePaths.map((path) => basename(path)) } : {}),
  };
  return runner.start({
    meta, renderStartedAtMs, logDetail: `${planned.endpointId}${meta.resolution ? ` ${meta.resolution}` : ''} ${planned.seconds}s${meta.estimatedCostUsd != null ? ` ~$${meta.estimatedCostUsd.toFixed(2)}` : ' cost unknown'}`,
    run: (job) => runHiggsfieldVideo(job, jobId, {
      apiKey, spec, sourceImagePath, lastImagePath, referenceImagePaths, audioFilePath, meta,
      uploadedTempPath, uploadedTempPaths, frameAspect,
    }),
  });
}

// A frame is cropped to the project's aspect (Music Video) before upload, like the fal lane.
async function uploadFrame({ apiKey, path, aspect, signal }) {
  const { dataUri, conformed } = await frameDataUriAtAspect(path, aspect);
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUri);
  const bytes = match ? Buffer.from(match[2], 'base64') : null;
  // Unrecognized bytes can carry fal's PNG fallback label. Check the upload bytes instead.
  const contentType = detectImageFormat(bytes)?.mime;
  if (!contentType || contentType !== match[1]) {
    throw new ServerError('Higgsfield accepts PNG, JPEG, WebP or GIF frames', { status: 400, code: 'HIGGSFIELD_INPUT_INVALID' });
  }
  const url = await uploadHiggsfieldFile({ apiKey, bytes, contentType, signal });
  return { url, conformed };
}

async function runHiggsfieldVideo(job, jobId, {
  apiKey, spec, sourceImagePath, lastImagePath, referenceImagePaths, audioFilePath, meta,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null,
}) {
  const { entry, finishFailure, publish, fail } = runner.begin(job, createHiggsfieldRequestEntry(apiKey), {
    inputs: [uploadedTempPath, ...(Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [])],
  });
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
    // The catalog renders a frame-anchored take silent, so the song window is not uploaded for it.
    const audioUrls = audioFilePath && !start ? [await uploadHiggsfieldFile({ apiKey, bytes: await readFile(audioFilePath), contentType: 'audio/wav', signal })] : [];
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
    const buffer = await runner.download(entry, polled.outputUrl, { timeoutMs: HIGGSFIELD_DOWNLOAD_TIMEOUT_MS, label: 'Higgsfield video' });
    if (entry.aborted) return finishFailure('Canceled');
    if (await publish({ buffer, meta, actualSeed: request.body.seed ?? null })) void autoDeleteHostedCopy('higgsfield', 'video', jobId, { apiKey });
  } catch (err) {
    return fail(err);
  }
}
