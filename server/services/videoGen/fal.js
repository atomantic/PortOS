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
import { join } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import { describeFetchError } from '../../lib/fetchErrorChain.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { probeVideoDuration, probeVideoGeometry } from '../../lib/ffmpeg.js';
import {
  FAL_DEFAULT_IMAGE_VIDEO_MODEL,
  FAL_DEFAULT_TEXT_VIDEO_MODEL,
  buildFalVideoRequest,
  getFalVideoModel,
} from '../../lib/falVideoModels.js';
import { attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { finalizeGeneratedVideo, emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { getSettings } from '../settings.js';
import { nearestAspectRatio } from '../imageGen/modes.js';

// The aspect_ratio set the LEGACY body sends for a model outside the curated
// catalog — matches the free-tool automation's FAL_ASPECT_RATIOS
// (services/fableLoom/falVideoAutomation.js). Curated models carry their own
// aspect rules (or none: an image-to-video canvas follows its start frame).
export const FAL_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
export const deriveAspectRatio = (width, height) => nearestAspectRatio(width, height, FAL_ASPECT_RATIOS);

export const FAL_QUEUE_BASE = 'https://queue.fal.run';

// The defaults when a request names no model, one text-first and one
// image-first (MiniMax Hailuo-02 standard) — owned by the catalog.
export const FAL_DEFAULT_TEXT_MODEL = FAL_DEFAULT_TEXT_VIDEO_MODEL;
export const FAL_DEFAULT_IMAGE_MODEL = FAL_DEFAULT_IMAGE_VIDEO_MODEL;

const FAL_SUBMIT_TIMEOUT_MS = 30_000;
const FAL_POLL_TIMEOUT_MS = 15_000;
const FAL_POLL_INTERVAL_MS = 3000;
// A transient status-fetch failure (network blip, fal.ai 5xx) gets this many
// additional attempts — on the same FAL_POLL_INTERVAL_MS cadence, never
// resubmitting the paid generation — before the run is abandoned (#8340).
const FAL_MAX_STATUS_RETRIES = 2;
const FAL_MAX_READ_RETRIES = 2;
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

/**
 * Resolve the fal.ai API key: settings override, else the `FAL_KEY` env var
 * (same settings-wins-over-env precedence as `loras.js`'s Civitai key).
 */
export function resolveFalApiKey(settings) {
  const fromSettings = (settings?.videoGen?.fal?.apiKey || '').trim();
  if (fromSettings) return fromSettings;
  const fromEnv = (process.env.FAL_KEY || '').trim();
  return fromEnv || null;
}

// Best-effort, idempotent cancellation of the remote fal.ai request — shared
// by explicit user cancellation (cancel()/cancelAll()) and every local
// abandonment path (exhausted status retries, the render deadline) so an
// already-known cancel_url is never left unsent (#8340). A caught failure is
// logged for diagnosis but never rethrown: the local job still finalizes as
// failed/canceled either way. Guarded so it never re-sends once fired, and
// never fires once the remote request already reached a fal-reported
// terminal state (COMPLETED/ERROR) — there is nothing left to cancel there.
async function cancelFalRequest(entry) {
  if (!entry || entry.canceledRemote || entry.remoteTerminal || !entry.cancelUrl || !entry.apiKey) return;
  entry.canceledRemote = true;
  try {
    const res = await fetchWithTimeout(entry.cancelUrl, {
      method: 'PUT',
      headers: { Authorization: `Key ${entry.apiKey}` },
    }, FAL_POLL_TIMEOUT_MS);
    if (!res.ok) console.error(`❌ fal.ai cancellation request failed: HTTP ${res.status}`);
  } catch (err) {
    console.error(`❌ fal.ai cancellation request failed: ${err?.message || err}`);
  }
}

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

async function toDataUri(imagePath) {
  const buf = await readFile(imagePath);
  const detected = detectImageFormat(buf);
  const mime = detected?.mime || 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

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

async function submitFalJob({ apiKey, modelId, body }) {
  const res = await fetchWithTimeout(`${FAL_QUEUE_BASE}/${modelId}`, {
    method: 'POST',
    headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, FAL_SUBMIT_TIMEOUT_MS);
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.request_id) {
    const reason = payload?.detail ? JSON.stringify(payload.detail) : `HTTP ${res.status}`;
    throw new ServerError(`fal.ai rejected the request: ${reason}`, { status: 502, code: 'FAL_SUBMIT_FAILED' });
  }
  return payload;
}

async function pollFalStatus({ statusUrl, apiKey }) {
  const res = await fetchWithTimeout(statusUrl, {
    headers: { Authorization: `Key ${apiKey}` },
  }, FAL_POLL_TIMEOUT_MS);
  if (!res.ok) throw new ServerError(`fal.ai status check failed: HTTP ${res.status}`, { status: 502, code: 'FAL_STATUS_FAILED' });
  return res.json();
}

/** A short, single-line reason from a fal error response body (`detail` string or validation list), or ''. */
async function falErrorDetail(response) {
  const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
  if (!text) return '';
  let reason = text;
  try {
    const body = JSON.parse(text);
    const detail = body?.detail ?? body?.error ?? body?.message;
    reason = Array.isArray(detail)
      ? detail.map((d) => [d?.loc?.slice?.(-1)?.[0], d?.msg || d?.type].filter(Boolean).join(': ')).join('; ')
      : typeof detail === 'string' ? detail : JSON.stringify(detail ?? body);
  } catch { /* not JSON: keep the text */ }
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Retry only reads of the already-paid render, including body consumption.
// Schema/JSON errors and permanent HTTP failures must not enter this loop.
async function readCompletedRender(url, { apiKey, signal, deadline, video = false }) {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('fal.ai retrieval deadline exceeded');
    let response;
    try {
      response = await fetchWithTimeout(url, {
        ...(apiKey ? { headers: { Authorization: `Key ${apiKey}` } } : {}),
        signal,
      }, Math.min(remaining, video ? FAL_DOWNLOAD_TIMEOUT_MS : FAL_POLL_TIMEOUT_MS));
      if (!response.ok) {
        const transientRead = response.status === 408 || response.status === 429 || (response.status >= 500 && response.status <= 599);
        // A permanent failure on the result read is how fal reports a job that
        // failed on its side (a 422 with a `detail` naming the input or policy
        // violation). Keep that reason — without it the job just says "HTTP 422".
        const detail = !transientRead && !video ? await falErrorDetail(response) : '';
        const error = new Error(`fal.ai ${video ? 'video download' : 'result retrieval'} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
        error.transientRead = transientRead;
        throw error;
      }
      const value = await (video ? response.arrayBuffer() : response.json());
      signal.throwIfAborted();
      return value;
    } catch (err) {
      // Release error responses without waiting for an error body to download.
      // A rejected consumer has already released its fetch deadline.
      if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
      signal.throwIfAborted();
      if (err instanceof SyntaxError) throw new Error('fal.ai did not return valid result JSON');
      const transient = err.transientRead ?? (err.name === 'AbortError' || err.name === 'TimeoutError' ||
        /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|fetch failed|network error|socket hang up/i.test(describeFetchError(err)));
      if (!transient || attempt >= FAL_MAX_READ_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * (2 ** attempt), Math.max(0, deadline - Date.now()))));
    }
  }
}

export async function generateVideo({
  apiKey: providedApiKey, settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height,
  sourceImagePath = null, jobId: providedJobId = null,
  audioFilePath = null, lipSync = null, shotInstruction = null,
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
      audioUrl: audioFilePath ? 'pending:audio' : null,
    });
  } catch (err) {
    if (err?.code !== 'FAL_MODEL_INPUT') throw err;
    throw new ServerError(err.message, { status: 400, code: 'VALIDATION_ERROR' });
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
    apiKey, modelId, prompt, negativePrompt, duration, aspectRatio: effectiveAspectRatio, sourceImagePath, outputPath, filename, meta,
    audioFilePath, enableTranscription: lipSync?.enableTranscription === true,
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

async function runFalVideo(job, jobId, {
  apiKey, modelId, prompt, negativePrompt, duration, aspectRatio, sourceImagePath, outputPath, filename, meta,
  audioFilePath = null, enableTranscription = false, requestSpec = null,
}) {
  const entry = {
    apiKey, controller: new AbortController(), aborted: false, cancelUrl: null, canceledRemote: false, remoteTerminal: false,
  };
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + FAL_RENDER_TIMEOUT_MS;
  try {
    const imageDataUri = sourceImagePath ? await toDataUri(sourceImagePath) : null;
    const audioDataUri = audioFilePath
      ? `data:audio/wav;base64,${(await readFile(audioFilePath)).toString('base64')}`
      : null;
    const body = requestSpec
      ? buildFalVideoRequest({ ...requestSpec, imageUrl: imageDataUri, audioUrl: audioDataUri }).body
      : audioFilePath
        ? buildLipSyncRequestBody({ imageDataUri, audioDataUri, enableTranscription })
        : buildRequestBody({ prompt, negativePrompt, duration, aspectRatio, imageDataUri });
    // Cancelled while the inputs were being read: nothing was submitted, so
    // there is nothing to pay for or cancel remotely.
    if (entry.aborted) return finalizeCanceled(job, jobId);
    const submitted = await submitFalJob({ apiKey, modelId, body });
    entry.cancelUrl = submitted.cancel_url || `${FAL_QUEUE_BASE}/${modelId}/requests/${submitted.request_id}/cancel`;
    const statusUrl = submitted.status_url || `${FAL_QUEUE_BASE}/${modelId}/requests/${submitted.request_id}/status`;
    const responseUrl = submitted.response_url || `${FAL_QUEUE_BASE}/${modelId}/requests/${submitted.request_id}`;

    let statusFailures = 0;
    while (Date.now() < deadline) {
      if (entry.aborted) return finalizeCanceled(job, jobId);
      videoGenEvents.emit('activity', { generationId: jobId });
      let status;
      try {
        status = await pollFalStatus({ statusUrl, apiKey });
      } catch (err) {
        statusFailures += 1;
        if (statusFailures > FAL_MAX_STATUS_RETRIES) {
          await cancelFalRequest(entry);
          return finalizeJobFailure(job, jobId, null, `fal.ai status checks failed ${statusFailures} times in a row: ${err?.message || err}`);
        }
        await new Promise((r) => setTimeout(r, FAL_POLL_INTERVAL_MS));
        continue;
      }
      statusFailures = 0;
      if (status.status === 'COMPLETED') {
        entry.remoteTerminal = true;
        break;
      }
      if (status.status === 'ERROR') {
        entry.remoteTerminal = true;
        return finalizeJobFailure(job, jobId, null, `fal.ai render failed: ${status.error || 'unknown error'}`);
      }
      // fal's own queue maps to SUBMIT rather than to the queued step: the
      // ladder's `queued` is PortOS's local queue, and stepping back to it
      // after the handover would read as the render having lost its place.
      if (status.status === 'IN_PROGRESS') emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.RENDER, 'Rendering…');
      else emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Queued at fal.ai…');
      await new Promise((r) => setTimeout(r, FAL_POLL_INTERVAL_MS));
    }
    if (entry.aborted) return finalizeCanceled(job, jobId);
    if (Date.now() >= deadline) {
      await cancelFalRequest(entry);
      return finalizeJobFailure(job, jobId, null, `fal.ai did not finish within ${Math.round(FAL_RENDER_TIMEOUT_MS / 1000)}s`);
    }

    const buffer = await withAbortTimeout(FAL_DOWNLOAD_TIMEOUT_MS, async (timeoutSignal) => {
      const signal = anyAbortSignal([timeoutSignal, entry.controller.signal]);
      const retrievalDeadline = Date.now() + FAL_DOWNLOAD_TIMEOUT_MS;
      const result = await readCompletedRender(responseUrl, { apiKey, signal, deadline: retrievalDeadline });
      const videoUrl = result?.video?.url || result?.video_url || result?.output?.video?.url;
      if (typeof videoUrl !== 'string' || !videoUrl.trim()) {
        throw new Error('fal.ai completed but returned no video URL');
      }
      emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.FETCH, 'Downloading video…');
      return Buffer.from(await readCompletedRender(videoUrl, { signal, deadline: retrievalDeadline, video: true }));
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
    await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta: { ...meta, ...measured }, actualSeed: null, mutateHistory: mutateVideoHistory });
    closeJobAfterDelay(jobs, jobId);
  } catch (err) {
    // Best-effort: an unanticipated throw (e.g. from fetchFalResult or the
    // download) may still leave the remote render queued or running — cancel
    // it before finalizing. `cancelFalRequest` already no-ops once
    // entry.remoteTerminal is set (fal reported COMPLETED/ERROR) or the
    // request was never submitted (no cancelUrl yet), so this never sends a
    // stray cancel for a job that already finished on fal.ai's side (#8340).
    //
    // finalizeGeneratedVideo marks job.status='complete' BEFORE its async
    // post-processing (faststart/thumbnail/history), and the request slot is
    // already released above — a throw there must still surface as a terminal
    // failure or the queue's job stays 'running' until the watchdog and the
    // client never gets a terminal frame. Force past the idempotence guard,
    // same as videoGen/grok.js's post-exit catch and reactor.js's catch-all (#6831).
    await cancelFalRequest(entry);
    if (entry.aborted) return finalizeCanceled(job, jobId);
    finalizeJobFailure(job, jobId, null, `fal.ai video generation failed: ${err?.message || err}`, { force: true });
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
  toDataUri,
};
