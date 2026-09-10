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
 */

import { randomUUID } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer } from '../../lib/sseUtils.js';
import { videoGenEvents } from './events.js';
import { finalizeGeneratedVideo, emitCloudRenderStatus, CLOUD_RENDER_PHASE } from './generateVideoHelpers.js';
import { mutateVideoHistory } from './history.js';
import { getSettings } from '../settings.js';
import { nearestAspectRatio } from '../imageGen/modes.js';

// fal.ai's aspect_ratio set for the minimax hailuo-02 models this provider
// targets — matches the free-tool automation's FAL_ASPECT_RATIOS
// (services/fableLoom/falVideoAutomation.js) so both fal.ai paths agree on
// what the backend actually accepts.
export const FAL_ASPECT_RATIOS = Object.freeze(['16:9', '9:16', '1:1']);
export const deriveAspectRatio = (width, height) => nearestAspectRatio(width, height, FAL_ASPECT_RATIOS);

export const FAL_QUEUE_BASE = 'https://queue.fal.run';

// The two models the issue names, one text-first and one image-first. Both
// accept `prompt`; the image-to-video variant additionally takes `image_url`.
export const FAL_DEFAULT_TEXT_MODEL = 'fal-ai/minimax/hailuo-02/standard/text-to-video';
export const FAL_DEFAULT_IMAGE_MODEL = 'fal-ai/minimax/hailuo-02/standard/image-to-video';

const FAL_SUBMIT_TIMEOUT_MS = 30_000;
const FAL_POLL_TIMEOUT_MS = 15_000;
const FAL_POLL_INTERVAL_MS = 3000;
const FAL_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
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

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("videoGen/fal.cancel requires a jobId — use cancelAll() to terminate every in-flight render");
  }
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  if (entry.cancelUrl && entry.apiKey) {
    fetchWithTimeout(entry.cancelUrl, {
      method: 'PUT',
      headers: { Authorization: `Key ${entry.apiKey}` },
    }, FAL_POLL_TIMEOUT_MS).catch(() => {});
  }
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

async function fetchFalResult({ responseUrl, apiKey }) {
  const res = await fetchWithTimeout(responseUrl, {
    headers: { Authorization: `Key ${apiKey}` },
  }, FAL_POLL_TIMEOUT_MS);
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload) {
    throw new ServerError('fal.ai did not return a usable result', { status: 502, code: 'FAL_RESULT_FAILED' });
  }
  return payload;
}

export async function generateVideo({
  apiKey: providedApiKey, settings, modelId: requestedModelId,
  prompt = '', negativePrompt, duration, aspectRatio, width, height,
  sourceImagePath = null, jobId: providedJobId = null,
}) {
  await ensureDir(PATHS.videos);
  const renderStartedAtMs = Date.now();

  if (!prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
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

  const modelId = requestedModelId || (sourceImagePath ? FAL_DEFAULT_IMAGE_MODEL : FAL_DEFAULT_TEXT_MODEL);
  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  // An explicit aspectRatio always wins (e.g. FableLoom's visualConditioning
  // render parameters); otherwise derive the nearest fal-supported ratio from
  // the request's width/height, same as grok's deriveAspectRatio.
  const effectiveAspectRatio = FAL_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : deriveAspectRatio(width, height);

  const meta = {
    id: jobId,
    prompt: prompt.trim(),
    negativePrompt: negativePrompt || '',
    modelId: `fal:${modelId}`,
    ...(duration ? { duration } : {}),
    ...(effectiveAspectRatio ? { aspectRatio: effectiveAspectRatio } : {}),
    filename,
    createdAt: new Date().toISOString(),
    mode: sourceImagePath ? 'image' : 'text',
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}] fal (${modelId}): ${prompt.slice(0, 60)}…`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: 1, ...meta });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0 });
  emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.SUBMIT, 'Submitting to fal.ai…');

  runFalVideo(job, jobId, { apiKey, modelId, prompt, negativePrompt, duration, aspectRatio: effectiveAspectRatio, sourceImagePath, outputPath, filename, meta })
    .catch((err) => {
      console.log(`❌ fal video run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
    });

  return {
    jobId, filename, path: `/data/videos/${filename}`, generationId: jobId,
    mode: 'fal',
    status: 'running',
  };
}

async function runFalVideo(job, jobId, { apiKey, modelId, prompt, negativePrompt, duration, aspectRatio, sourceImagePath, outputPath, filename, meta }) {
  const entry = { apiKey, aborted: false, cancelUrl: null };
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + FAL_RENDER_TIMEOUT_MS;
  try {
    const imageDataUri = sourceImagePath ? await toDataUri(sourceImagePath) : null;
    const body = buildRequestBody({ prompt, negativePrompt, duration, aspectRatio, imageDataUri });
    const submitted = await submitFalJob({ apiKey, modelId, body });
    entry.cancelUrl = submitted.cancel_url || `${FAL_QUEUE_BASE}/${modelId}/requests/${submitted.request_id}/cancel`;
    const statusUrl = submitted.status_url || `${FAL_QUEUE_BASE}/${modelId}/requests/${submitted.request_id}/status`;
    const responseUrl = submitted.response_url || `${FAL_QUEUE_BASE}/${modelId}/requests/${submitted.request_id}`;

    while (Date.now() < deadline) {
      if (entry.aborted) return finalizeCanceled(job, jobId);
      videoGenEvents.emit('activity', { generationId: jobId });
      const status = await pollFalStatus({ statusUrl, apiKey });
      if (status.status === 'COMPLETED') break;
      if (status.status === 'ERROR') {
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
      return finalizeJobFailure(job, jobId, null, `fal.ai did not finish within ${Math.round(FAL_RENDER_TIMEOUT_MS / 1000)}s`);
    }

    const result = await fetchFalResult({ responseUrl, apiKey });
    const videoUrl = result?.video?.url || result?.video_url || result?.output?.video?.url;
    if (!videoUrl) {
      return finalizeJobFailure(job, jobId, null, 'fal.ai completed but returned no video URL');
    }

    emitCloudRenderStatus(job, jobId, CLOUD_RENDER_PHASE.FETCH, 'Downloading video…');
    const videoRes = await fetchWithTimeout(videoUrl, {}, FAL_DOWNLOAD_TIMEOUT_MS);
    if (!videoRes.ok) {
      return finalizeJobFailure(job, jobId, null, `fal.ai video download failed: HTTP ${videoRes.status}`);
    }
    const buffer = Buffer.from(await videoRes.arrayBuffer());
    await writeFile(outputPath, buffer);

    activeRequests.delete(jobId);
    activeJobs.delete(jobId);
    await finalizeGeneratedVideo({ job, jobId, outputPath, filename, meta, actualSeed: null, mutateHistory: mutateVideoHistory });
    closeJobAfterDelay(jobs, jobId);
  } catch (err) {
    // NOTE: not forced, unlike videoGen/grok.js's post-exit catch — see #6831.
    // finalizeGeneratedVideo stamps job.status = 'complete' before its own
    // async tail (same as here), so a throw from that tail after the request
    // slot is already cleared above lands here as a silent no-op today.
    finalizeJobFailure(job, jobId, null, `fal.ai video generation failed: ${err?.message || err}`);
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
