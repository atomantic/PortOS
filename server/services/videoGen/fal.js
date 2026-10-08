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

import { randomUUID } from 'crypto';
import { readFile, writeFile, unlink } from 'fs/promises';
import { join, relative, resolve, isAbsolute } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import {
  FAL_DEFAULT_IMAGE_VIDEO_MODEL,
  FAL_DEFAULT_TEXT_VIDEO_MODEL,
  buildFalVideoRequest,
  getFalVideoModel,
} from '../../lib/falVideoModels.js';
import { probeVideoDuration, probeVideoGeometry } from '../../lib/ffmpeg.js';
import { attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { discardUnpublishedVideo, finalizeGeneratedVideo, emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { mutateVideoHistory } from './history.js';
import { getSettings } from '../settings.js';
import { nearestAspectRatio } from '../imageGen/modes.js';
import {
  FAL_QUEUE_BASE, awaitFalCompletion, cancelFalRequest, createFalRequestEntry, fileToDataUri,
  readCompletedFalResult, resolveFalApiKey, submitFalRequest,
} from '../falQueue.js';

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

// Per-job state — keyed by jobId (cloud lane allows parallel renders). Same
// client shape as videoGen/grok.js so attachSseClient/broadcastSse work.
const jobs = new Map();
// Tracks the fal.ai request so cancel() can both stop our poll loop and ask
// fal.ai to cancel the queued/running render.
const activeRequests = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("videoGen/fal.cancel requires a jobId — use cancelAll() to terminate every in-flight render");
  }
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.controller.abort();
  cancelFalRequest(entry);
  return true;
};

export const cancelAll = () => {
  const ids = [...activeRequests.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

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

export async function generateVideo({
  apiKey: providedApiKey, settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height,
  sourceImagePath = null, lastImagePath = null, jobId: providedJobId = null,
  audioFilePath = null, lipSync = null, shotInstruction = null,
  uploadedTempPath = null, uploadedTempPaths = [],
  resolution = null, generateAudio = false,
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
  // A lip-sync render conditions a reference frame on source audio; either
  // input alone is not a request this route can honor.
  if (audioFilePath && !sourceImagePath) {
    throw new ServerError('A fal.ai lip-sync render needs a reference frame', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // The queue only persists the resolved provider CONFIG a job needs (mirrors
  // grokPath on the grok lane) — never a secret — so the key is re-resolved
  // from live settings here, exactly like mediaJobQueue's own pythonPath
  // re-resolution on every dispatch, rather than threaded through job.params
  // where it would sit in plaintext in media-jobs.json.
  const effectiveSettings = settings || (providedApiKey ? null : await getSettings().catch(() => null));
  const apiKey = providedApiKey || resolveFalApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError('No fal.ai API key configured — set it in Settings > Video Gen or the FAL_KEY env var', { status: 400, code: 'FAL_NOT_CONFIGURED' });
  }

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  // An explicit aspectRatio always wins (e.g. FableLoom's visualConditioning
  // render parameters); otherwise derive the nearest fal-supported ratio from
  // the request's width/height, same as grok's deriveAspectRatio. Legacy body
  // only — a curated model resolves its own aspect rule.
  const effectiveAspectRatio = FAL_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : deriveAspectRatio(width, height);

  // A lip-sync take is billed on its audio length: the shot instruction's
  // planned window, else the staged slice itself.
  const audioSec = audioFilePath
    ? (shotInstruction?.audioWindow?.durationSec || await probeVideoDuration(audioFilePath).catch(() => null))
    : null;
  const requestSpec = {
    modelId, prompt, negativePrompt, seconds: duration, audioSec, aspectRatio, width, height, resolution,
    generateAudio: generateAudio === true, enableTranscription: lipSync?.enableTranscription === true,
  };
  // Dry-run the curated body with placeholder media before anything is read or
  // paid for: a missing required input refuses here as a 400, and the result
  // carries the coerced length, resolution and estimate the history records.
  let planned = null;
  try {
    planned = buildFalVideoRequest({
      ...requestSpec,
      imageUrl: sourceImagePath ? 'pending:image' : null,
      endImageUrl: lastImagePath ? 'pending:end-image' : null,
      audioUrl: audioFilePath ? 'pending:audio' : null,
    });
  } catch (err) {
    if (err?.code !== 'FAL_MODEL_INPUT') throw err;
    throw new ServerError(err.message, { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (lastImagePath && !planned) {
    throw new ServerError('End frames require a fal.ai model with catalogued end-frame support', { status: 400, code: 'VALIDATION_ERROR' });
  }

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
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
    ...(audioFilePath ? { lipSync: true } : {}),
    ...(shotInstruction?.audioWindow ? { audioWindow: shotInstruction.audioWindow } : {}),
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  const costNote = meta.estimatedCostUsd != null ? ` ~$${meta.estimatedCostUsd.toFixed(2)}` : ' cost unknown';
  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] fal (${modelId}${meta.resolution ? ` ${meta.resolution}` : ''}${costNote}): ${(prompt || '(lip-sync)').slice(0, 60)}…`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Submitting to fal.ai…');

  runFalVideo(job, jobId, {
    apiKey, modelId, prompt, negativePrompt, duration, aspectRatio: effectiveAspectRatio, sourceImagePath, lastImagePath, outputPath, filename, meta,
    audioFilePath, uploadedTempPath, uploadedTempPaths, enableTranscription: lipSync?.enableTranscription === true,
    requestSpec: planned ? requestSpec : null,
  })
    .catch((err) => {
      console.error(`❌ fal video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
    });

  return {
    jobId, filename, path: `/data/videos/${filename}`, generationId: jobId,
    mode: 'fal',
    status: 'running',
  };
}

const isStagedUpload = (path) => {
  const rel = relative(PATHS.uploads, resolve(path));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

// The staged voice clip keeps its upload's extension (a performance slice is always WAV).
function audioMimeType(path) {
  const ext = String(path).toLowerCase().split('.').pop();
  return {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', opus: 'audio/ogg',
    flac: 'audio/flac', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff',
  }[ext] || 'audio/wav';
}

async function runFalVideo(job, jobId, {
  apiKey, modelId, prompt, negativePrompt, duration, aspectRatio, sourceImagePath, lastImagePath, outputPath, filename, meta,
  audioFilePath = null, uploadedTempPath = null, uploadedTempPaths = [], enableTranscription = false, requestSpec = null,
}) {
  const entry = createFalRequestEntry(apiKey);
  const publication = {};
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + FAL_RENDER_TIMEOUT_MS;
  try {
    const imageDataUri = sourceImagePath ? await fileToDataUri(sourceImagePath) : null;
    const endImageDataUri = lastImagePath ? await fileToDataUri(lastImagePath) : null;
    const audioDataUri = audioFilePath
      ? `data:${audioMimeType(audioFilePath)};base64,${(await readFile(audioFilePath)).toString('base64')}`
      : null;
    const body = requestSpec
      ? buildFalVideoRequest({ ...requestSpec, imageUrl: imageDataUri, endImageUrl: endImageDataUri, audioUrl: audioDataUri }).body
      : audioFilePath
        ? buildLipSyncRequestBody({ imageDataUri, audioDataUri, enableTranscription })
        : buildRequestBody({ prompt, negativePrompt, duration, aspectRatio, imageDataUri });
    // Cancelled while the inputs were being read: nothing was submitted, so
    // there is nothing to pay for or cancel remotely.
    if (entry.aborted) return finalizeCanceled(job, jobId);
    const submitted = await submitFalRequest({ apiKey, modelId, body });
    entry.cancelUrl = submitted.cancel_url;
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
    if (polled.outcome === 'canceled') return finalizeCanceled(job, jobId);
    if (polled.outcome === 'failed') return finalizeJobFailure(job, jobId, null, polled.reason);

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
    if (entry.aborted) return finalizeCanceled(job, jobId);
    await writeFile(outputPath, buffer);
    if (entry.aborted) {
      await unlink(outputPath);
      return finalizeCanceled(job, jobId);
    }

    // Record what the provider actually delivered: fal reports no frame count,
    // and the Music Video renderer trims every clip by numFrames/fps — the
    // measured length is also what a performance take's edit points index.
    const measured = (await probeVideoGeometry(outputPath)) || {};
    const expectedSec = meta.audioWindow?.durationSec;
    if (expectedSec && measured.durationSec && measured.durationSec + 0.1 < expectedSec) {
      console.warn(`⚠️ fal lip-sync [${jobId.slice(0, 8)}] delivered ${measured.durationSec.toFixed(2)}s for a ${expectedSec.toFixed(2)}s audio window`);
    }
    activeRequests.delete(jobId);
    activeJobs.delete(jobId);
    await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta: { ...meta, ...measured }, actualSeed: null, mutateHistory: mutateVideoHistory, publication });
    closeJobAfterDelay(jobs, jobId);
  } catch (err) {
    // Best-effort: an unanticipated throw (e.g. from fetchFalResult or the
    // download) may still leave the remote render queued or running — cancel
    // it before finalizing. `cancelFalRequest` already no-ops once
    // entry.remoteTerminal is set (fal reported COMPLETED/ERROR) or the
    // request was never submitted (no cancelUrl yet), so this never sends a
    // stray cancel for a job that already finished on fal.ai's side (#8340).
    //
    // A dispatch failure can follow the durable commit. Never remove those
    // bytes; a failure before publication cleans only this fresh output.
    if (!publication.committed) await discardUnpublishedVideo({ jobId, outputPath }).catch(error => {
      maintenance.markCurrentUnsettled();
      maintenance.markResourceUnsettled('media', jobId);
      console.error(`❌ fal video publication cleanup failed [${jobId.slice(0, 8)}]: ${error.message}`);
    });
    await cancelFalRequest(entry);
    if (entry.aborted) return finalizeCanceled(job, jobId);
    finalizeJobFailure(job, jobId, null, `fal.ai video generation failed: ${err?.message || err}`, { force: true });
  } finally {
    // The inline inputs are spent on every terminal outcome. Delete only
    // queue-owned uploads; gallery frames and the original song stay intact.
    const inputs = new Set([uploadedTempPath, audioFilePath, ...(Array.isArray(uploadedTempPaths) ? uploadedTempPaths : [])]);
    for (const path of inputs) {
      if (path && isStagedUpload(path)) await unlink(path).catch(() => {});
    }
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'fal video generation',
  events: videoGenEvents,
});
const finalizeCanceled = finalizeJobFailure.canceled;

// Test-only handles.
export const _internals = {
  buildRequestBody,
  toDataUri: fileToDataUri,
};
