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

import { basename } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, buildRunwayVideoRequest, getRunwayVideoModel } from '../../lib/runwayVideoModels.js';
import { falClipReferenceAddition } from '../../lib/storyboardGuidance.js';
import { getRunwaySpecialVideoModel, buildRunwaySpecialVideoRequest } from '../../lib/runwaySpecialVideoModels.js';
import { validateRunwayVideoInput } from './runwayVideoInputs.js';
import { videoGenEvents } from './events.js';
import { emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { createHostedVideoJobRunner } from './hostedJobRunner.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
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

const runner = createHostedVideoJobRunner({ mode: 'runway', provider: 'Runway', cancelRemote: cancelRunwayTask });
export const { getActiveJob, attachSseClient, cancel, cancelAll } = runner;

/**
 * Dry-run the request body with placeholder frames before anything is read or
 * paid for: a missing input or an over-cap prompt refuses here as a 400. Returns
 * the plan and the record of the text Runway receives (#11317); the Video Gen
 * form's preview calls it with the same inputs.
 */
export function runwayVideoSentPrompt({ hasImage = false, hasEndImage = false, hasVideo = false, hasCharacterVideo = false, clipReferenceLabels = [], promptAdditions = [], ...spec }) {
  // Named after the director's text, in the order the images are sent.
  const clipReferences = clipReferenceLabels.length
    ? falClipReferenceAddition(getRunwayVideoModel(spec.modelId), clipReferenceLabels, { hasImage, prompt: spec.prompt || '' }) : null;
  const prompt = clipReferences ? [spec.prompt?.trim(), clipReferences.text].filter(Boolean).join('\n') : spec.prompt;
  let planned;
  try {
    const build = getRunwaySpecialVideoModel(spec.modelId) ? buildRunwaySpecialVideoRequest : buildRunwayVideoRequest;
    planned = build({
      ...spec,
      prompt,
      referenceImageUris: clipReferenceLabels.map((_, index) => `pending:reference-${index + 1}`),
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
    added: [clipReferences, planned.model.negativePrompt ? null : promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', spec.negativePrompt)],
  });
  return { planned, record, prompt };
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
  const { default: sharp } = await import('sharp');
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

export const generateVideo = (params) => runner.prepare(params, generateVideoPrepared);

async function generateVideoPrepared({
  apiKey: providedApiKey, settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height,
  sourceImagePath = null, lastImagePath = null, referenceImagePaths = [], clipReferenceLabels = [], jobId,
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
    throw new ServerError('No Runway API key configured — set it in Settings → Credentials (or the RUNWAYML_API_SECRET env var)', { status: 400, code: 'RUNWAY_NOT_CONFIGURED' });
  }
  const requestSpec = {
    modelId, prompt, negativePrompt, seconds: duration, aspectRatio: frameAspect || aspectRatio, width, height, resolution,
    videoMode, targetAspectRatio, ratio, bodyControl, expressionIntensity,
    ...(Number.isInteger(seed) ? { seed } : {}),
  };
  const { planned, record: sentRecord, prompt: sentPrompt } = runwayVideoSentPrompt({
    ...requestSpec, promptAdditions, clipReferenceLabels, hasImage: !!sourceImagePath, hasEndImage: !!lastImagePath, hasVideo: !!runwayVideoPath, hasCharacterVideo: !!runwayCharacterVideoPath,
  });
  requestSpec.prompt = sentPrompt;

  const filename = `${jobId}.mp4`;
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
    ...(referenceImagePaths.length ? { clipReferenceFiles: referenceImagePaths.map((path) => basename(path)) } : {}),
    filename,
    createdAt: new Date().toISOString(),
    mode: special?.mode || (sourceImagePath ? 'image' : 'text'),
    ...(shotInstruction?.audioWindow ? { audioWindow: shotInstruction.audioWindow } : {}),
  };
  const costNote = meta.estimatedCostUsd != null ? ` ~$${meta.estimatedCostUsd.toFixed(2)}` : ' cost unknown';
  return runner.start({
    meta, renderStartedAtMs, logDetail: `${planned.model.id}${meta.resolution ? ` ${meta.resolution}` : ''}${costNote}`,
    run: (job) => runRunwayVideo(job, jobId, {
      apiKey, requestSpec, sourceImagePath, lastImagePath, referenceImagePaths, meta,
      uploadedTempPath, uploadedTempPaths, frameAspect,
      runwayVideoPath, runwayCharacterVideoPath,
    }),
  });
}

async function runRunwayVideo(job, jobId, {
  apiKey, requestSpec, sourceImagePath, lastImagePath, referenceImagePaths = [], meta,
  uploadedTempPath = null, uploadedTempPaths = [], frameAspect = null,
  runwayVideoPath = null, runwayCharacterVideoPath = null,
}) {
  const { entry, finishFailure, publish, fail } = runner.begin(job, createRunwayTaskEntry(apiKey), {
    inputs: [uploadedTempPath, ...(Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [])],
  });
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
    // A reference keeps its own framing: only the shot's frames conform to the project aspect.
    const references = await Promise.all(referenceImagePaths.map((path) => runwayFrameDataUri(path, null)));
    const videoUri = runwayVideoPath ? await uploadRunwayVideo({ apiKey, filePath: runwayVideoPath, signal: entry.controller.signal }) : null;
    const characterVideoUri = runwayCharacterVideoPath ? await uploadRunwayVideo({ apiKey, filePath: runwayCharacterVideoPath, signal: entry.controller.signal }) : null;
    const build = special ? buildRunwaySpecialVideoRequest : buildRunwayVideoRequest;
    const { body, endpoint } = build({ ...requestSpec, videoUri, characterVideoUri, imageUri: frame?.dataUri ?? null, endImageUri: endFrame?.dataUri ?? null, referenceImageUris: references.map((ref) => ref.dataUri) });
    if (entry.aborted) return finishFailure('Canceled');
    entry.taskId = await submitRunwayTask({ apiKey, endpoint, body, signal: entry.controller.signal });
    meta.runwayTaskId = entry.taskId;

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
    const buffer = await runner.download(entry, polled.outputUrl, { timeoutMs: RUNWAY_DOWNLOAD_TIMEOUT_MS, label: 'Runway video' });
    if (entry.aborted) return finishFailure('Canceled');
    if (await publish({ buffer, meta })) void autoDeleteHostedCopy('runway', 'video', jobId, { apiKey });
  } catch (err) {
    return fail(err);
  }
}
