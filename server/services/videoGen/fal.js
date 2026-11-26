/**
 * Video Gen — fal.ai queue REST API provider (#6213).
 *
 * FableLoom already talks to fal.ai's free `minimax-h3-max` web tool through
 * brittle Playwright CDP automation (`services/fableLoom/falVideoAutomation.js`)
 * that breaks on CAPTCHAs, cookie modals, and DOM changes. This module is a
 * first-class MediaGen video backend that instead calls fal.ai's metered
 * queue REST API directly with `FAL_KEY` — no browser required. It mirrors
 * `videoGen/grok.js`'s job-map/SSE contract (cloud lane, no local child
 * process) so `mediaJobQueue` can dispatch to it the same way.
 *
 * Flow: POST the prompt (and an optional base64-encoded source image) to
 * `queue.fal.run/{model}`, poll the returned status URL until COMPLETED, then
 * download the resulting MP4 and hand it to the shared `finalizeGeneratedVideo`
 * helper — same streaming optimization, thumbnail, and history entry as every
 * other video backend.
 *
 * The request body is built per model from the curated catalog
 * (lib/falVideoModels.js): parameter names and wire types differ per family
 * (Hailuo's string "6", H3's integer 5, Veo's "8s", Kling's start_image_url),
 * and a lip-sync route takes no prompt at all. A model id outside the catalog
 * keeps the legacy Hailuo-shaped body so a free-text id still renders; its
 * cost is recorded as unknown.
 */

import { storyboardGuidanceMeta } from './storyboardGuidance.js';
import { readFile } from 'fs/promises';
import { basename } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import {
  FAL_DEFAULT_IMAGE_VIDEO_MODEL,
  FAL_DEFAULT_TEXT_VIDEO_MODEL,
  buildFalVideoRequest,
  falPromptExpansionAddition,
  falPromptExpansionMode,
  falHearsAudioReference,
  getFalVideoModel,
} from '../../lib/falVideoModels.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';
import { videoGenEvents } from './events.js';
import { emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { createHostedVideoJobRunner } from './hostedJobRunner.js';
import { getSettings } from '../settings.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
import { nearestAspectRatio } from '../imageGen/modes.js';
import { frameDataUriAtAspect } from './falFrameAspect.js';
import {
  FAL_QUEUE_BASE, awaitFalCompletion, cancelFalRequest, createFalRequestEntry, fileToDataUri, hostFalDataUri,
  readCompletedFalResult, resolveFalApiKey, submitFalRequest,
} from '../falQueue.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';
import { falClipReferenceAddition, falReferenceImageName, storyboardGuidanceAddition, storyboardGuidanceText } from '../../lib/storyboardGuidance.js';

// The queue transport (submit / poll / retrieve / cancel) is shared with the
// fal.ai image backend in `services/falQueue.js`. Re-exported so existing
// importers of the key resolver and base URL keep their path.
export { FAL_QUEUE_BASE, resolveFalApiKey };

// The aspect_ratio set the LEGACY body sends for a model outside the curated
// catalog — matches the free-tool automation's FAL_ASPECT_RATIOS
// (services/fableLoom/falVideoAutomation.js). Curated models carry their own
// aspect rules (or none: an image-to-video canvas follows its start frame).
export const FAL_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
export const deriveAspectRatio = (width, height) => nearestAspectRatio(width, height, FAL_ASPECT_RATIOS);

// The defaults when a request names no model, one text-first and one
// image-first (MiniMax Hailuo-02 standard) — owned by the catalog.
export const FAL_DEFAULT_TEXT_MODEL = FAL_DEFAULT_TEXT_VIDEO_MODEL;
export const FAL_DEFAULT_IMAGE_MODEL = FAL_DEFAULT_IMAGE_VIDEO_MODEL;

// Bounds completed-result retrieval, backoff, and the WHOLE download — headers and every byte of the video — now that
// `fetchWithTimeout` holds its deadline through body consumption. It used to
// bound only the headers, which left the multi-MB transfer itself with no
// ceiling: a stalled body pinned the media job in `running` until the queue
// watchdog reaped it 30 minutes later. Ten minutes is far more than a finished
// render takes to transfer and still well inside that watchdog.
const FAL_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// A cloud queue render can sit behind other tenants' jobs before it starts —
// generously bounded, same order of magnitude as grok's image-first cap.
const FAL_RENDER_TIMEOUT_MS = (() => {
  const n = Number(process.env.FAL_VIDEO_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();

const runner = createHostedVideoJobRunner({ mode: 'fal', provider: 'fal.ai', logName: 'fal', cancelRemote: cancelFalRequest });
export const { getActiveJob, attachSseClient, cancel, cancelAll } = runner;

// Legacy source-audio body for a lip-sync model id outside the catalog; the
// curated MiniMax H3 lip-sync route (#8977) builds through the catalog, which
// also sends its output resolution. Neither takes a prompt, duration or aspect
// ratio — output length follows the submitted audio.
function buildLipSyncRequestBody({ imageDataUri, audioDataUri, enableTranscription }) {
  return {
    image_url: imageDataUri,
    audio_url: audioDataUri,
    ...(enableTranscription ? { enable_transcription: true } : {}),
  };
}

// Legacy Hailuo-shaped body for a model id outside the curated catalog.
function buildRequestBody({ prompt, negativePrompt, duration, aspectRatio, imageDataUri }) {
  // fal.ai's queue REST API has no dedicated negative-prompt field for these
  // models — fold it into the prompt as an "Avoid:" clause, same fallback
  // grok.js uses for a provider that lacks a native field.
  const avoid = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  const body = { prompt: `${prompt.trim()}${avoid}` };
  if (duration) body.duration = String(duration);
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (imageDataUri) body.image_url = imageDataUri;
  return body;
}

/**
 * Dry-run the curated request body with placeholder media before anything is
 * read or paid for: a missing required input or an over-cap prompt refuses here
 * as a 400, and the plan carries the coerced length, resolution and estimate the
 * history records. Returns the plan with the record of the text fal receives
 * (#11317); the Video Gen form's preview calls it with the same inputs.
 */
export function falVideoSentPrompt({ hasImage = false, hasVideo = false, hasEndImage = false, hasAudio = false, guidanceReferences = null, referenceCount = 0, clipReferenceLabels = null, promptAdditions = [], ...spec }) {
  const modelId = spec.modelId || (hasImage ? FAL_DEFAULT_IMAGE_MODEL : FAL_DEFAULT_TEXT_MODEL);
  const { negativePrompt } = spec;
  // A storyboard-guided render (`guidanceReferences`: how many reference images
  // join the panel) sends the panel as reference 1, never as a start frame, and
  // names each reference's role after the director's text.
  const guidance = guidanceReferences == null ? null : falStoryboardGuidance(getFalVideoModel(modelId), guidanceReferences);
  const clipReferences = clipReferenceLabels == null ? null
    : falClipReferenceAddition(getFalVideoModel(modelId), clipReferenceLabels, { hasImage, prompt: spec.prompt || '' });
  const prompt = guidance || clipReferences
    ? [spec.prompt?.trim(), guidance?.addition.text, clipReferences?.text].filter(Boolean).join('\n') : (spec.prompt ?? '');
  // A reference model hears the audio as a prompt-named reference ("Audio 1").
  const audioAsReference = hasAudio && falHearsAudioReference(getFalVideoModel(modelId));
  let planned = null;
  try {
    planned = buildFalVideoRequest({
      ...spec, modelId, prompt,
      // A sequence take (#14241) sends one frame per shot, named in its prompt as Image n.
      ...(guidance ? { referenceImageUrls: guidance.placeholders }
        : referenceCount > 0 ? { referenceImageUrls: Array.from({ length: referenceCount }, (_, i) => `pending:reference-${i + 1}`) } : {}),
      imageUrl: hasImage ? 'pending:image' : null,
      videoUrl: hasVideo ? 'pending:video' : null,
      endImageUrl: hasEndImage ? 'pending:end-image' : null,
      audioUrl: hasAudio && !audioAsReference ? 'pending:audio' : null,
      referenceAudioUrls: audioAsReference ? ['pending:audio'] : [],
    });
  } catch (err) {
    if (err?.code !== 'FAL_MODEL_INPUT') throw err;
    throw new ServerError(err.message, { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (hasEndImage && !planned) {
    throw new ServerError('End frames require a fal.ai model with catalogued end-frame support', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // The text fal receives: a negative prompt the model has no field for rides folded in as "Avoid:".
  const record = sentPromptRecord({
    sentPrompt: planned ? (planned.body.prompt ?? '') : buildRequestBody({ prompt, negativePrompt }).prompt,
    sentNegativePrompt: planned?.body.negative_prompt ?? null,
    carried: carriedPromptAdditions({ promptAdditions }),
    added: [
      guidance?.addition ?? null,
      clipReferences,
      falPromptExpansionAddition(falPromptExpansionMode(planned?.model, spec.promptExpansion)),
      (!planned || planned.model.negativePrompt === 'fold') && planned?.model.prompt !== 'none'
      ? promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', negativePrompt) : null],
  });
  return { planned, record, prompt };
}

// The panel is @Image1 / "Image 1"; the references follow it in order.
function falStoryboardGuidance(model, referenceCount) {
  const names = Array.from({ length: referenceCount + 1 }, (_, i) => falReferenceImageName(model, i));
  return {
    placeholders: names.map((_, i) => `pending:guidance-${i}`),
    addition: storyboardGuidanceAddition(storyboardGuidanceText({ guidance: names[0], references: names.slice(1) })),
  };
}

export const generateVideo = (params) => runner.prepare(params, generateVideoPrepared);

async function generateVideoPrepared({
  apiKey: providedApiKey, settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height,
  sourceImagePath = null, lastImagePath = null, jobId,
  audioFilePath = null, lipSync = null, shotInstruction = null,
  uploadedTempPath = null, uploadedTempPaths = [],
  resolution = null, generateAudio = false, frameAspect = null, promptAdditions = [], musicVideo = null,
  guidanceImagePath = null, referenceImagePaths = [], clipReferenceLabels = null,
  sourceVideoPath = null, extendedFrom = null, extendSourceSec = null, lookAround = null,
}) {
  await ensureDir(PATHS.videos);
  const renderStartedAtMs = Date.now();

  const modelId = requestedModelId || (sourceImagePath ? FAL_DEFAULT_IMAGE_MODEL : FAL_DEFAULT_TEXT_MODEL);
  const catalogModel = getFalVideoModel(modelId);
  // A lip-sync route has no prompt field at all — the frame and the song slice
  // are the whole request — so only a prompted model (or an uncurated id, whose
  // legacy body always carries one) requires it.
  const promptRequired = catalogModel ? catalogModel.prompt === 'required' : !audioFilePath;
  if (promptRequired && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // A lip-sync or audio-to-video render conditions a reference frame on
  // source audio; either input alone is not a request this route can honor.
  if (audioFilePath && !sourceImagePath) {
    throw new ServerError('A fal.ai source-audio render needs a reference frame', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // The queue only persists the resolved provider CONFIG a job needs (mirrors
  // grokPath on the grok lane) — never a secret — so the key is re-resolved
  // from live settings here, exactly like mediaJobQueue's own pythonPath
  // re-resolution on every dispatch, rather than threaded through job.params
  // where it would sit in plaintext in media-jobs.json.
  const effectiveSettings = settings || (providedApiKey ? null : await getSettings().catch(() => null));
  const apiKey = providedApiKey || resolveFalApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError('No fal.ai API key configured — set it in Settings → Credentials or the FAL_KEY env var', { status: 400, code: 'FAL_NOT_CONFIGURED' });
  }

  const filename = `${jobId}.mp4`;
  // An explicit aspectRatio always wins (e.g. FableLoom's visualConditioning
  // render parameters); otherwise derive the nearest fal-supported ratio from
  // the request's width/height, same as grok's deriveAspectRatio. Legacy body
  // only — a curated model resolves its own aspect rule.
  const effectiveAspectRatio = FAL_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : deriveAspectRatio(width, height);

  // A source-audio take is billed on its audio length: the shot instruction's
  // planned window, else the staged slice itself.
  const audioSec = audioFilePath
    ? (shotInstruction?.audioWindow?.durationSec || await probeVideoDuration(audioFilePath).catch(() => null))
    : null;
  // A reference model renders a set length, not one that follows its audio: the clip covers the song slice.
  const audioAsReference = !!audioFilePath && falHearsAudioReference(catalogModel);
  const requestSpec = {
    modelId, prompt, negativePrompt, seconds: audioAsReference ? (duration ?? audioSec) : duration, audioSec, aspectRatio, width, height, resolution,
    generateAudio: generateAudio === true, enableTranscription: lipSync?.enableTranscription === true,
    // A shot card shows the text that is sent, so the provider may not rewrite it.
    ...(musicVideo ? { promptExpansion: 'disabled' } : {}),
  };
  // Without a storyboard panel the references go in as given: a music-video sequence take (#14241).
  const guidanceImages = guidanceImagePath ? [guidanceImagePath, ...referenceImagePaths] : referenceImagePaths;
  const { planned, record: sentRecord, prompt: guidedPrompt } = falVideoSentPrompt({
    ...requestSpec, promptAdditions,
    hasImage: !!sourceImagePath, hasVideo: !!sourceVideoPath, hasEndImage: !!lastImagePath, hasAudio: !!audioFilePath,
    guidanceReferences: guidanceImagePath ? referenceImagePaths.length : null,
    referenceCount: guidanceImagePath ? 0 : referenceImagePaths.length,
    clipReferenceLabels: guidanceImagePath ? null : clipReferenceLabels,
  });
  // The guided render sends the prompt with its role lines, exactly as the record shows.
  if (guidanceImagePath || clipReferenceLabels != null) requestSpec.prompt = guidedPrompt;

  const meta = {
    id: jobId,
    prompt: (prompt || '').trim(),
    negativePrompt: negativePrompt || '',
    modelId: `fal:${modelId}`,
    ...(planned
      ? {
        ...(planned.seconds != null ? { duration: planned.seconds } : {}),
        ...(planned.body.aspect_ratio ? { aspectRatio: planned.body.aspect_ratio } : {}),
        ...(planned.resolution ? { resolution: planned.resolution } : {}),
        ...(planned.model.audio ? { generateAudio: planned.generateAudio } : {}),
      }
      : {
        ...(duration ? { duration } : {}),
        ...(effectiveAspectRatio ? { aspectRatio: effectiveAspectRatio } : {}),
      }),
    // What PortOS expected this render to cost at fal's list price, or null for
    // an uncurated model — recorded so spend can be audited per clip.
    estimatedCostUsd: planned?.estimatedCostUsd ?? null,
    ...(modelId === 'minimax/h3-max/reference-to-video' && referenceImagePaths.length
      ? { estimatedCostExcludesReferenceInputs: true } : {}),
    ...sentRecord,
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
    // #16150: the clip this render continues.
    ...(extendedFrom ? { extendedFrom, ...(extendSourceSec ? { extendSourceSec } : {}) } : {}),
    // #16145: a place's look-around clip names its place, motion and main plate (catalogLookAround.js).
    ...(lookAround?.ingredientId ? { lookAround } : {}),
    ...storyboardGuidanceMeta(guidanceImagePath, referenceImagePaths),
    ...(clipReferenceLabels != null && !guidanceImagePath ? { clipReferenceFiles: referenceImagePaths.map((path) => basename(path)) } : {}),
    // A lip-sync take syncs a mouth; an audio-to-video take moves the whole frame to the audio.
    ...(audioFilePath ? (catalogModel?.kind === 'a2v' || audioAsReference ? { audioDriven: true } : { lipSync: true }) : {}),
    ...(shotInstruction?.audioWindow ? { audioWindow: shotInstruction.audioWindow } : {}),
  };
  const costNote = meta.estimatedCostUsd != null ? ` ~$${meta.estimatedCostUsd.toFixed(2)}` : ' cost unknown';
  return runner.start({
    meta, renderStartedAtMs, logDetail: `${modelId}${meta.resolution ? ` ${meta.resolution}` : ''}${costNote}`,
    run: (job) => runFalVideo(job, jobId, {
      apiKey, modelId, prompt, negativePrompt, duration, aspectRatio: effectiveAspectRatio, sourceImagePath, lastImagePath, meta,
      audioFilePath, uploadedTempPath, uploadedTempPaths, enableTranscription: lipSync?.enableTranscription === true,
      requestSpec: planned ? requestSpec : null, frameAspect, guidanceImages, sourceVideoPath,
    }),
  });
}

// The staged voice clip keeps its upload's extension (a performance slice is always WAV).
function audioMimeType(path) {
  const ext = String(path).toLowerCase().split('.').pop();
  return {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg',
    flac: 'audio/flac', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff',
  }[ext] || 'audio/wav';
}

async function runFalVideo(job, jobId, {
  apiKey, modelId, prompt, negativePrompt, duration, aspectRatio, sourceImagePath, lastImagePath, meta,
  audioFilePath = null, uploadedTempPath = null, uploadedTempPaths = [], enableTranscription = false, requestSpec = null,
  frameAspect = null, guidanceImages = [], sourceVideoPath = null,
}) {
  const { entry, finishFailure, publish, fail } = runner.begin(job, createFalRequestEntry(apiKey), {
    inputs: [uploadedTempPath, audioFilePath, ...(Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [])],
  });
  const deadline = Date.now() + FAL_RENDER_TIMEOUT_MS;
  try {
    // A Music Video clip's frames are cropped to its project's aspect, since
    // most routes size the output canvas from the start frame (falFrameAspect.js).
    const frame = sourceImagePath ? await frameDataUriAtAspect(sourceImagePath, frameAspect) : null;
    const endFrame = lastImagePath ? await frameDataUriAtAspect(lastImagePath, frameAspect) : null;
    const imageDataUri = frame?.dataUri ?? null;
    const endImageDataUri = endFrame?.dataUri ?? null;
    for (const [label, fit] of [['start', frame], ['end', endFrame]]) {
      if (fit?.conformed) console.log(`✂️ Cropped fal ${label} frame [${jobId.slice(0, 8)}] ${fit.conformed.from} → ${fit.conformed.to} for ${frameAspect}`);
    }
    if (frame?.conformed || endFrame?.conformed) {
      meta.frameConformed = { aspect: frameAspect, ...(frame?.conformed ? { start: frame.conformed } : {}), ...(endFrame?.conformed ? { end: endFrame.conformed } : {}) };
    }
    const audioDataUri = audioFilePath
      ? `data:${audioMimeType(audioFilePath)};base64,${(await readFile(audioFilePath)).toString('base64')}`
      : null;
    // Most routes read inputs inline; a model that downloads them gets fal-hosted URLs.
    const hosted = getFalVideoModel(modelId)?.hostedInputs === true;
    const host = (dataUri, name) => (hosted && dataUri ? hostFalDataUri({ apiKey, dataUri, fileName: `${jobId}-${name}` }) : dataUri);
    // An extend render continues the source clip, hosted like any other input.
    const videoDataUri = sourceVideoPath ? `data:video/mp4;base64,${(await readFile(sourceVideoPath)).toString('base64')}` : null;
    const [imageUrl, endImageUrl, audioUrl, videoUrl, ...referenceImageUrls] = await Promise.all([
      host(imageDataUri, 'start'), host(endImageDataUri, 'end'), host(audioDataUri, 'audio'), host(videoDataUri, 'source'),
      // A storyboard panel and its references go in uncropped: none is a frame of the clip.
      ...guidanceImages.map(async (path, i) => host((await frameDataUriAtAspect(path, null)).dataUri, `reference-${i + 1}`)),
    ]);
    const audioInputs = falHearsAudioReference(getFalVideoModel(modelId)) ? { referenceAudioUrls: audioUrl ? [audioUrl] : [] } : { audioUrl };
    const body = requestSpec
      ? buildFalVideoRequest({ ...requestSpec, imageUrl, videoUrl, endImageUrl, ...audioInputs, ...(referenceImageUrls.length ? { referenceImageUrls } : {}) }).body
      : audioFilePath
        ? buildLipSyncRequestBody({ imageDataUri: imageUrl, audioDataUri: audioUrl, enableTranscription })
        : buildRequestBody({ prompt, negativePrompt, duration, aspectRatio, imageDataUri: imageUrl });
    // Cancelled while the inputs were being read: nothing was submitted, so
    // there is nothing to pay for or cancel remotely.
    if (entry.aborted) return finishFailure('Canceled');
    const submitted = await submitFalRequest({ apiKey, modelId, body });
    entry.cancelUrl = submitted.cancel_url;
    meta.falRequestId = submitted.request_id;
    const responseUrl = submitted.response_url;

    const polled = await awaitFalCompletion({
      entry, statusUrl: submitted.status_url, apiKey, deadline, timeoutMs: FAL_RENDER_TIMEOUT_MS,
      onPoll: () => videoGenEvents.emit('activity', { generationId: jobId }),
      // fal's own queue maps to SUBMIT rather than to the queued step: the
      // ladder's `queued` is PortOS's local queue, and stepping back to it
      // after the handover would read as the render having lost its place.
      onStatus: (status) => (status === 'IN_PROGRESS'
        ? emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.RENDER, 'Rendering…')
        : emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Queued at fal.ai…')),
    });
    if (polled.outcome === 'canceled') return finishFailure('Canceled');
    if (polled.outcome === 'failed') return finishFailure(polled.reason);

    const buffer = await withAbortTimeout(FAL_DOWNLOAD_TIMEOUT_MS, async (timeoutSignal) => {
      const signal = anyAbortSignal([timeoutSignal, entry.controller.signal]);
      const retrievalDeadline = Date.now() + FAL_DOWNLOAD_TIMEOUT_MS;
      const result = await readCompletedFalResult(responseUrl, { apiKey, signal, deadline: retrievalDeadline });
      const videoUrl = result?.video?.url || result?.video_url || result?.output?.video?.url;
      if (typeof videoUrl !== 'string' || !videoUrl.trim()) {
        throw new Error('fal.ai completed but returned no video URL');
      }
      emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.FETCH, 'Downloading video…');
      return Buffer.from(await readCompletedFalResult(videoUrl, {
        signal, deadline: retrievalDeadline, binary: true, binaryTimeoutMs: FAL_DOWNLOAD_TIMEOUT_MS, label: 'video download',
      }));
    });
    if (entry.aborted) return finishFailure('Canceled');
    // fal reports no frame count, so the measured length is also what a
    // performance take's edit points index.
    const published = await publish({
      buffer, meta,
      onMeasured: (measured) => {
        const expectedSec = meta.audioWindow?.durationSec;
        if (expectedSec && measured.durationSec && measured.durationSec + 0.1 < expectedSec) {
          console.warn(`⚠️ fal source-audio take [${jobId.slice(0, 8)}] delivered ${measured.durationSec.toFixed(2)}s for a ${expectedSec.toFixed(2)}s audio window`);
        }
      },
    });
    if (published) void autoDeleteHostedCopy('fal', 'video', jobId, { apiKey });
  } catch (err) {
    // cancelFalRequest no-ops once fal reported COMPLETED/ERROR or before
    // anything was submitted, so this never sends a stray cancel (#8340).
    return fail(err);
  }
}

// Test-only handles.
export const _internals = {
  buildRequestBody,
  toDataUri: fileToDataUri,
};
