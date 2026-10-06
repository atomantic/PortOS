import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
/**
 * Image Gen — fal.ai queue REST API provider.
 *
 * The one image backend that is a metered HTTP API rather than a local CLI:
 * it submits to fal.ai's queue (`services/falQueue.js`, the transport the
 * fal.ai video backend also uses), polls until the render completes, downloads
 * the output, and lands it in the gallery with the same job/SSE/event contract
 * as `grok.js` / `agy.js` / `codex.js` — so the media queue dispatches it on
 * the parallel cloud lane exactly like them.
 *
 * Why it exists: strong reference-conditioned EDIT models (nano-banana, Seedream,
 * FLUX.2) are what make a consistent character sheet or set plate out of a
 * mood board. Any render that carries an input image routes to the chosen
 * family's `/edit` endpoint with the images attached as `image_urls`; a
 * text-only render goes to the family's text-to-image endpoint. The catalog,
 * per-model request builders and prices live in `lib/falImageModels.js`.
 *
 * Money: every submit is billed. The dispatcher refuses unless
 * `imageGen.fal.enabled` is on, `checkConnection` never submits (it reads the
 * free pricing endpoint), the model is validated against the curated catalog
 * rather than passed through as free text, and each render records its
 * estimated cost in the gallery sidecar.
 *
 * The API key is the same one the fal.ai video backend uses (settings
 * `videoGen.fal.apiKey`, hydrated from the private key store, or `FAL_KEY`).
 * It is re-resolved from live settings at dispatch and never rides in the
 * persisted queue job params.
 */

import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import { atomicWrite, detectImageFormat, ensureDir, PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import {
  FAL_IMAGE_DEFAULT_MODEL, FAL_MEGAPIXEL, buildFalImageRequest, falImageFamily,
} from '../../lib/falImageModels.js';
import {
  broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer, dispatchTerminalEvent,
} from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import {
  awaitFalCompletion, cancelFalRequest, createFalRequestEntry, readCompletedFalResult, resolveFalApiKey,
  submitFalRequest,
} from '../falQueue.js';
import { IMAGE_GEN_MODE, describeFidelity, visualReferenceRole } from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { rejectDegenerateFrame } from './frameGuard.js';

const MODE = IMAGE_GEN_MODE.FAL;

// An image render normally finishes in well under a minute, but fal.ai's queue
// can hold a request behind other tenants' work before it starts. Generous,
// and inside the media queue's cloud-lane watchdog (the poll loop emits
// 'activity' every few seconds, so that watchdog's idle clock never trips on a
// healthy wait). Env-overridable like the other cloud providers' caps.
const FAL_IMAGE_TIMEOUT_MS = (() => {
  const n = Number(process.env.FAL_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
})();
// Bounds result retrieval plus the whole image download (headers and body).
const FAL_IMAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const FAL_PRICING_URL = 'https://api.fal.ai/v1/models/pricing';
const FAL_PRICING_TIMEOUT_MS = 10_000;

// Inputs travel inline as base64 data URIs (the pattern the video backend
// uses — no separate upload step, nothing left behind on fal.ai's storage).
// A mood board can hold full-resolution photos, and up to 14 of them ride in
// one JSON body, so an input bigger than this is downscaled first. No model in
// the catalog conditions on more detail than this anyway.
const INPUT_MAX_LONG_SIDE = 2048;
const INPUT_MAX_BYTES = 4 * 1024 * 1024;

const jobs = new Map();
// jobId → the fal.ai request entry (falQueue.createFalRequestEntry), so
// cancel() can stop the poll loop AND cancel the billed remote request.
const activeRequests = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

// Cancel one specific render. jobId is required — with parallel renders an
// anonymous cancel would stop every in-flight one; use cancelAll() for that.
export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error('imageGen/fal.cancel requires a jobId — use cancelAll() to terminate every in-flight render');
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

const noKeyReason = 'No fal.ai API key configured — add it under Settings → Image Gen → Defaults (shared with the fal.ai video backend) or set FAL_KEY';

/**
 * Connection probe that never spends money: confirm a key is configured, then
 * ask fal.ai's FREE pricing endpoint for the chosen model — an authenticated
 * read that proves the key works and doubles as the price shown to the user.
 */
export async function checkConnection({ model } = {}) {
  const family = falImageFamily(model) || falImageFamily(FAL_IMAGE_DEFAULT_MODEL);
  const settings = await getSettings().catch(() => null);
  const apiKey = resolveFalApiKey(settings);
  if (!apiKey) return { connected: false, mode: MODE, reason: noKeyReason };
  const url = `${FAL_PRICING_URL}?endpoint_id=${encodeURIComponent(family.textEndpoint)}`;
  const res = await fetchWithTimeout(url, { headers: { Authorization: `Key ${apiKey}` } }, FAL_PRICING_TIMEOUT_MS)
    .catch((err) => ({ ok: false, status: 0, error: err }));
  if (res.status === 401 || res.status === 403) {
    return { connected: false, mode: MODE, reason: `fal.ai rejected the API key (HTTP ${res.status})` };
  }
  if (!res.ok) {
    const detail = res.error ? res.error.message : `HTTP ${res.status}`;
    return { connected: false, mode: MODE, reason: `fal.ai pricing check failed: ${detail}` };
  }
  const payload = await res.json().catch(() => null);
  const price = payload?.prices?.find((p) => p?.endpoint_id === family.textEndpoint);
  const priceLabel = price ? ` — $${price.unit_price}/${price.unit === 'images' ? 'image' : price.unit}` : '';
  return { connected: true, mode: MODE, model: `${family.label}${priceLabel}`, modelId: family.textEndpoint };
}

/**
 * The prompt a fal.ai edit model receives. These models read the attached
 * images in order and take plain-language direction about them, so the
 * init/reference roles the CLI providers spell out as tool arguments are
 * spelled out here as prose, with the same fidelity + reference wording the
 * CLI prompt builders share (describeFidelity / visualReferenceRole).
 */
function buildFalPrompt({ prompt, hasInitImage = false, initImageStrength, referenceCount = 0 }) {
  const lines = [prompt.trim()];
  if (hasInitImage) {
    lines.push(`The first attached image is the source image to edit — ${describeFidelity(initImageStrength)}.`);
    if (referenceCount) {
      lines.push(`The remaining attached ${referenceCount === 1 ? 'image is' : 'images are'} ${visualReferenceRole(referenceCount)}.`);
    }
  } else if (referenceCount) {
    lines.push(`Use the attached ${referenceCount === 1 ? 'image' : 'images'} as ${visualReferenceRole(referenceCount)}.`);
  }
  return lines.join('\n\n');
}

// Read one input image into a data URI — the original bytes when they are a
// web format within the size budget, else a downscaled re-encode — and report
// its size in megapixels (FLUX.2 bills input megapixels).
async function encodeInputImage(filePath) {
  const metadata = await sharp(filePath).metadata();
  const longSide = Math.max(metadata.width || 0, metadata.height || 0);
  const passThrough = longSide <= INPUT_MAX_LONG_SIDE
    && (metadata.size ?? 0) <= INPUT_MAX_BYTES
    && ['png', 'jpeg', 'webp'].includes(metadata.format);
  if (passThrough) {
    const buffer = await readFile(filePath);
    const mime = detectImageFormat(buffer)?.mime || `image/${metadata.format}`;
    return { dataUri: `data:${mime};base64,${buffer.toString('base64')}`, megapixels: ((metadata.width || 0) * (metadata.height || 0)) / FAL_MEGAPIXEL };
  }
  const resized = sharp(filePath)
    .rotate()
    .resize({ width: INPUT_MAX_LONG_SIDE, height: INPUT_MAX_LONG_SIDE, fit: 'inside', withoutEnlargement: true });
  // Keep an alpha channel lossless; everything else goes JPEG to keep the
  // request body small.
  const mime = metadata.hasAlpha ? 'image/png' : 'image/jpeg';
  const { data, info } = await (metadata.hasAlpha ? resized.png() : resized.jpeg({ quality: 90 }))
    .toBuffer({ resolveWithObject: true });
  return { dataUri: `data:${mime};base64,${data.toString('base64')}`, megapixels: (info.width * info.height) / FAL_MEGAPIXEL };
}

// The first image URL in a fal.ai image result. Every catalog model answers
// `{ images: [{ url, … }] }`.
const firstImageUrl = (result) => {
  const url = Array.isArray(result?.images) ? result.images[0]?.url : null;
  return typeof url === 'string' && url.trim() ? url : null;
};

export async function generateImage({
  model, prompt = '', negativePrompt, width, height, seed,
  initImagePath, initImageStrength, referenceImagePaths = [],
  visualConditioning = null,
  jobId: providedJobId = null,
  cleanC2PA = false,
  denoise = false,
  apiKey: providedApiKey = null,
  settings = null,
}) {
  // The ingestion instant `renderTimingFields` measures from — see
  // lib/renderTiming.js.
  const renderStartedAtMs = Date.now();
  await ensureDir(PATHS.images);

  // The dispatcher / route already validated `model` against the catalog
  // (resolveCloudProviderConfig), and the queue persists the validated id.
  // This guard covers a direct caller and a job persisted by a build whose
  // catalog has since dropped the id — a paid call is never made against a
  // model the catalog does not describe.
  const family = falImageFamily(model || FAL_IMAGE_DEFAULT_MODEL);
  if (!family) {
    throw new ServerError(`fal.ai Imagegen has no model "${model}"`, { status: 400, code: 'FAL_IMAGE_MODEL_UNKNOWN' });
  }

  // Re-anchored to the allowed input roots and capped to THIS model's
  // reference limit (14 / 10 / 9) — see inputImages.js.
  const inputImages = resolveInputImages({
    mode: MODE, initImagePath, referenceImagePaths, modelId: family.textEndpoint,
  });
  if (cloudPromptRequired(MODE, inputImages.paths.length > 0) && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  // Never threaded through job params (they persist in plaintext) — resolved
  // from live settings at dispatch, same as videoGen/fal.js.
  const effectiveSettings = settings || (providedApiKey ? null : await getSettings().catch(() => null));
  const apiKey = providedApiKey || resolveFalApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError(noKeyReason, { status: 400, code: 'FAL_NOT_CONFIGURED' });
  }

  const endpointId = inputImages.paths.length ? family.editEndpoint : family.textEndpoint;
  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const fullPrompt = buildFalPrompt({
    prompt,
    hasInitImage: Boolean(inputImages.initPath),
    initImageStrength,
    referenceCount: inputImages.referencePaths.length,
  });

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: MODE,
    // The endpoint that actually rendered (text vs /edit), plus the family the
    // user chose — a gallery reader should not have to re-derive either.
    model: endpointId,
    modelFamily: family.id,
    ...(inputImages.paths.length ? { inputImageCount: inputImages.paths.length } : {}),
    ...(visualConditioning ? { visualConditioning } : {}),
    createdAt: new Date().toISOString(),
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] fal (${endpointId}): ${prompt.slice(0, 60)}…`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
  broadcastSse(job, { type: 'status', message: 'Submitting to fal.ai…' });

  // Returns the job descriptor synchronously; the paid request runs
  // out-of-band while the client attaches to the per-job SSE stream.
  runFal(job, jobId, {
    apiKey, family, fullPrompt, negativePrompt, width, height, seed,
    inputPaths: inputImages.paths, outputPath, filename, meta, cleanC2PA, denoise,
  }).catch((err) => {
    console.error(`❌ fal image run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/images/${filename}`, generationId: jobId,
    mode: MODE,
    status: 'running',
  };
}

async function runFal(job, jobId, {
  apiKey, family, fullPrompt, negativePrompt, width, height, seed,
  inputPaths, outputPath, filename, meta, cleanC2PA = false, denoise = false,
}) {
  const entry = createFalRequestEntry(apiKey);
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + FAL_IMAGE_TIMEOUT_MS;
  let wroteOutput = false;
  try {
    const encoded = [];
    for (const path of inputPaths) encoded.push(await encodeInputImage(path));
    const request = buildFalImageRequest({
      modelId: family.textEndpoint,
      prompt: fullPrompt,
      negativePrompt,
      width,
      height,
      seed,
      imageUrls: encoded.map((e) => e.dataUri),
      inputMegapixels: encoded.reduce((sum, e) => sum + e.megapixels, 0),
    });
    // Cancelled while the inputs were being encoded: nothing was submitted,
    // so there is nothing to pay for or cancel remotely.
    if (entry.aborted) return finalizeCanceled(job, jobId);

    const submitted = await submitFalRequest({ apiKey, modelId: request.endpointId, body: request.body });
    entry.cancelUrl = submitted.cancel_url;
    broadcastSse(job, { type: 'status', message: 'Queued at fal.ai…' });

    const polled = await awaitFalCompletion({
      entry, statusUrl: submitted.status_url, apiKey, deadline, timeoutMs: FAL_IMAGE_TIMEOUT_MS,
      onPoll: () => imageGenEvents.emit('activity', { generationId: jobId }),
      onStatus: (status) => broadcastSse(job, {
        type: 'status', message: status === 'IN_PROGRESS' ? 'Rendering…' : 'Queued at fal.ai…',
      }),
    });
    if (polled.outcome === 'canceled') return finalizeCanceled(job, jobId);
    if (polled.outcome === 'failed') return finalizeJobFailure(job, jobId, null, polled.reason);

    const { result, bytes } = await withAbortTimeout(FAL_IMAGE_DOWNLOAD_TIMEOUT_MS, async (timeoutSignal) => {
      const signal = anyAbortSignal([timeoutSignal, entry.controller.signal]);
      const retrievalDeadline = Date.now() + FAL_IMAGE_DOWNLOAD_TIMEOUT_MS;
      const response = await readCompletedFalResult(submitted.response_url, { apiKey, signal, deadline: retrievalDeadline });
      const imageUrl = firstImageUrl(response);
      if (!imageUrl) throw new Error('fal.ai completed but returned no image URL');
      broadcastSse(job, { type: 'status', message: 'Downloading image…' });
      const downloaded = await readCompletedFalResult(imageUrl, {
        signal, deadline: retrievalDeadline, binary: true, binaryTimeoutMs: FAL_IMAGE_DOWNLOAD_TIMEOUT_MS, label: 'image download',
      });
      return { result: response, bytes: Buffer.from(downloaded) };
    });
    if (entry.aborted) return finalizeCanceled(job, jobId);

    await withBackupAssetPublication(async () => {
      try {
        // Signature-sniff before anything reaches the gallery: an error page or
        // truncated body must never be accepted as an image. The gallery serves
        // by extension and sidecars assume PNG, so a JPEG/WebP result is
        // transcoded rather than shipped mislabeled.
        const format = detectImageFormat(bytes)?.format;
        if (!format) return finalizeJobFailure(job, jobId, null, 'fal.ai returned a file that is not an image');
        await atomicWrite(outputPath, format === 'png' ? bytes : await sharp(bytes).png().toBuffer());
        wroteOutput = true;
        if (entry.aborted) {
          await unlinkGuarded(outputPath).catch(() => {});
          return finalizeCanceled(job, jobId);
        }

        // Degenerate-frame gate (#4173) — a moderated/blank result must fail
        // here, not become a gallery record.
        const emptyFrame = await rejectDegenerateFrame(outputPath);
        if (emptyFrame) {
          await unlinkGuarded(outputPath).catch(() => {});
          return finalizeJobFailure(job, jobId, null, emptyFrame);
        }

        const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
        const actualSeed = Number.isInteger(result?.seed) ? result.seed : (request.body.seed ?? null);
        await atomicWrite(sidecar, {
          ...meta,
          ...(request.body.aspect_ratio ? { aspectRatio: request.body.aspect_ratio } : {}),
          ...(request.resolution ? { resolution: request.resolution } : {}),
          ...(actualSeed != null ? { seed: actualSeed } : {}),
          // An ESTIMATE from the catalog's published prices — fal.ai bills the
          // account; this only lets a gallery record say roughly what it cost.
          estimatedCostUsd: request.estimatedCostUsd,
          ...renderTimingFields(job.renderStartedAtMs),
        });
        // Cleaners run BEFORE the SSE complete + completed events so subscribers
        // see the cleaned bytes.
        await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode: MODE });
        job.status = 'complete';
        if (activeRequests.get(jobId) === entry) activeRequests.delete(jobId);
        activeJobs.delete(jobId);
        console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (fal ${request.endpointId}, ~$${request.estimatedCostUsd})`);
        const done = { filename, path: `/data/images/${filename}` };
        dispatchTerminalEvent(
          jobId,
          () => broadcastSse(job, { type: 'complete', result: done }),
          () => imageGenEvents.emit('completed', { mode: MODE, generationId: jobId, path: done.path, filename }),
        );
        closeJobAfterDelay(jobs, jobId);
      } catch (err) {
        if (wroteOutput && job.status !== 'complete') {
          await Promise.all([outputPath, join(PATHS.images, `${jobId}.metadata.json`)].map(path => unlinkGuarded(path).catch(() => {})));
        }
        throw err;
      }
    });
  } catch (err) {
    // An unanticipated throw (input encode, retrieval, transcode) may still
    // leave the remote request queued or running — cancel it. cancelFalRequest
    // no-ops once fal.ai reported a terminal state or before anything was
    // submitted. `force` because the success tail stamps 'complete' before its
    // last awaits.
    await cancelFalRequest(entry);
    if (entry.aborted) return finalizeCanceled(job, jobId);
    finalizeJobFailure(job, jobId, null, `fal.ai image generation failed: ${err?.message || err}`, { force: true });
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'fal image generation',
  events: imageGenEvents,
  failedPayload: (jobId, reason) => ({ mode: MODE, generationId: jobId, error: reason }),
});
const finalizeCanceled = finalizeJobFailure.canceled;

// Test-only handles.
export const _internals = { encodeInputImage, firstImageUrl };
