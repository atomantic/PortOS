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
 * free pricing endpoint), and a model is either a curated family or an id on
 * the loaded fal.ai image list. An implausible id, a listed id whose schema
 * cannot be read, or references the schema does not accept are refused before
 * the paid POST. Curated renders record an estimated cost; a listed model
 * records that the price is unknown.
 *
 * The API key is the same one the fal.ai video backend uses (settings
 * `videoGen.fal.apiKey`, hydrated from the private key store, or `FAL_KEY`).
 * It is re-resolved from live settings at dispatch and never rides in the
 * persisted queue job params.
 */

import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { stripImageMetadata } from '../../lib/imageClean.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { createConcurrencyGate } from '../../lib/concurrencyGate.js';
import {
  FAL_IMAGE_DEFAULT_MODEL, FAL_MEGAPIXEL, appendFalAvoid, buildFalImageRequest, buildListedFalImageRequest, falImageFamily,
  isPlausibleFalEndpointId,
} from '../../lib/falImageModels.js';
import * as falCatalog from '../falImageModelCatalog.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
import {
  awaitFalCompletion, cancelFalRequest, createFalRequestEntry, hostFalDataUri, readCompletedFalResult, resolveFalApiKey,
  submitFalRequest,
} from '../falQueue.js';
import { IMAGE_GEN_MODE, attachedImageRoles } from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { createHostedImageJobRunner } from './hostedJobRunner.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

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

// Inputs are downscaled if needed to stay within the size budget, and then
// uploaded to fal.ai's storage CDN (with per-image deduplication and
// bounded upload concurrency) rather than inlined as multi-megabyte data URIs.
// No model in the catalog conditions on more detail than this anyway.
const INPUT_MAX_LONG_SIDE = 2048;
const INPUT_MAX_BYTES = 4 * 1024 * 1024;
const FAL_UPLOAD_CONCURRENCY = Math.max(1, Number(process.env.FAL_UPLOAD_CONCURRENCY) || 2);
const FAL_HOSTED_INPUT_TTL_MS = 60 * 60 * 1000;
const MAX_REFERENCE_CACHE_ENTRIES = 200;

const uploadGate = createConcurrencyGate(FAL_UPLOAD_CONCURRENCY);
const inflightUploads = new Map();
const completedUploadCache = new Map();

function hashReferenceKey(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

function evictOldestCompletedCacheEntry() {
  if (completedUploadCache.size >= MAX_REFERENCE_CACHE_ENTRIES) {
    const oldestKey = completedUploadCache.keys().next().value;
    if (oldestKey) {
      const entry = completedUploadCache.get(oldestKey);
      if (entry?.timer) clearTimeout(entry.timer);
      completedUploadCache.delete(oldestKey);
    }
  }
}

function awaitReferenceUploadSubscriber({ entry, cacheKey, signal, deadline }) {
  if (signal?.aborted) signal.throwIfAborted();
  const now = Date.now();
  const remainingMs = deadline ? deadline - now : FAL_IMAGE_TIMEOUT_MS;
  if (remainingMs <= 0) {
    throw new ServerError(`deadline exceeded (${FAL_IMAGE_TIMEOUT_MS}ms budget)`, { status: 504, code: 'FAL_IMAGE_TIMEOUT' });
  }

  return new Promise((resolve, reject) => {
    const subId = Symbol();
    entry.subscribers.add(subId);

    let deadlineTimer = null;
    let settled = false;

    const cleanup = () => {
      entry.subscribers.delete(subId);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const unsubscribeAndAbortIfEmpty = () => {
      cleanup();
      if (entry.subscribers.size === 0) {
        entry.controller.abort();
        if (inflightUploads.get(cacheKey) === entry) {
          inflightUploads.delete(cacheKey);
        }
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      unsubscribeAndAbortIfEmpty();
      reject(signal.reason || new DOMException('Operation aborted', 'AbortError'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    deadlineTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribeAndAbortIfEmpty();
      reject(new ServerError(`timed out after ${remainingMs}ms waiting for reference upload`, { status: 504, code: 'FAL_IMAGE_TIMEOUT' }));
    }, remainingMs);
    deadlineTimer.unref?.();

    entry.promise.then(
      (url) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(url);
      },
      (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      },
    );
  });
}

async function uploadReferenceImage({ apiKey, dataUri, signal, deadline }) {
  if (signal?.aborted) signal.throwIfAborted();
  const now = Date.now();
  const remainingMs = deadline ? deadline - now : FAL_IMAGE_TIMEOUT_MS;
  if (remainingMs <= 0) {
    throw new ServerError(`deadline exceeded (${FAL_IMAGE_TIMEOUT_MS}ms budget)`, { status: 504, code: 'FAL_IMAGE_TIMEOUT' });
  }

  const dataHash = createHash('sha256').update(dataUri).digest('hex');
  const cacheKey = `${hashReferenceKey(apiKey)}:${dataHash}`;

  const inflight = inflightUploads.get(cacheKey);
  if (inflight) {
    return awaitReferenceUploadSubscriber({ entry: inflight, cacheKey, signal, deadline });
  }

  const cached = completedUploadCache.get(cacheKey);
  if (cached) {
    if (now < cached.expiresAt) {
      return cached.url;
    }
    if (cached.timer) clearTimeout(cached.timer);
    completedUploadCache.delete(cacheKey);
  }

  const uploadController = new AbortController();
  const subscribers = new Set();
  const inflightEntry = {
    controller: uploadController,
    subscribers,
    promise: null,
  };

  inflightEntry.promise = uploadGate.run(async () => {
    uploadController.signal.throwIfAborted();
    return hostFalDataUri({
      apiKey,
      dataUri,
      fileName: `ref-${dataHash.slice(0, 16)}`,
      signal: uploadController.signal,
    });
  }).then((url) => {
    if (inflightUploads.get(cacheKey) === inflightEntry) {
      inflightUploads.delete(cacheKey);
    }
    evictOldestCompletedCacheEntry();
    const expiresAt = Date.now() + FAL_HOSTED_INPUT_TTL_MS;
    const completedEntry = {
      url,
      expiresAt,
      timer: null,
    };
    const timer = setTimeout(() => {
      if (completedUploadCache.get(cacheKey) === completedEntry) {
        completedUploadCache.delete(cacheKey);
      }
    }, FAL_HOSTED_INPUT_TTL_MS);
    timer.unref?.();
    completedEntry.timer = timer;

    completedUploadCache.set(cacheKey, completedEntry);
    return url;
  }).catch((err) => {
    if (inflightUploads.get(cacheKey) === inflightEntry) {
      inflightUploads.delete(cacheKey);
    }
    throw err;
  });
  // Prevent unhandled rejection if all subscribers abandon or cancel before the upload settles.
  inflightEntry.promise.catch(() => {});

  inflightUploads.set(cacheKey, inflightEntry);
  return awaitReferenceUploadSubscriber({ entry: inflightEntry, cacheKey, signal, deadline });
}

const runner = createHostedImageJobRunner({ mode: MODE, provider: 'fal.ai', logName: 'fal', cancelRemote: cancelFalRequest });
export const { getActiveJob, getActiveJobs, attachSseClient, cancel, cancelAll } = runner;
const { finalizeJobFailure, finalizeCanceled } = runner;

const noKeyReason = 'No fal.ai API key configured — add it under Settings → Image Gen → Defaults (shared with the fal.ai video backend) or set FAL_KEY';

/**
 * Connection probe that never spends money: confirm a key is configured, then
 * ask fal.ai's FREE pricing endpoint for the chosen model — an authenticated
 * read that proves the key works and doubles as the price shown to the user.
 */
export async function checkConnection({ model } = {}) {
  const requested = typeof model === 'string' ? model.trim() : '';
  const family = falImageFamily(requested);
  const fallback = falImageFamily(FAL_IMAGE_DEFAULT_MODEL);
  // A curated edit pin still prices the family's text endpoint: that is the
  // published per-image rate. A listed id prices itself.
  const endpointId = family ? family.textEndpoint : (isPlausibleFalEndpointId(requested) ? requested : fallback.textEndpoint);
  const name = family ? family.label : endpointId;
  const settings = await getSettings().catch(() => null);
  const apiKey = resolveFalApiKey(settings);
  if (!apiKey) return { connected: false, mode: MODE, reason: noKeyReason };
  const url = `${FAL_PRICING_URL}?endpoint_id=${encodeURIComponent(endpointId)}`;
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
  const price = payload?.prices?.find((p) => p?.endpoint_id === endpointId);
  const priceLabel = price ? ` — $${price.unit_price}/${price.unit === 'images' ? 'image' : price.unit}` : '';
  return { connected: true, mode: MODE, model: `${name}${priceLabel}`, modelId: endpointId };
}

// Read one input image into a data URI — the original bytes when they are a
// web format within the size budget, else a downscaled re-encode — and report
// its size in megapixels (FLUX.2 bills input megapixels).
async function encodeInputImage(filePath, reviewedBytes = null) {
  const input = reviewedBytes ?? await readFile(filePath);
  const { default: sharp } = await import('sharp');
  const metadata = await sharp(input).metadata();
  const longSide = Math.max(metadata.width || 0, metadata.height || 0);
  const passThrough = longSide <= INPUT_MAX_LONG_SIDE
    && input.length <= INPUT_MAX_BYTES
    && ['png', 'jpeg', 'webp'].includes(metadata.format);
  if (passThrough) {
    const clean = stripImageMetadata(input).data;
    const mime = detectImageFormat(clean)?.mime || `image/${metadata.format}`;
    return { dataUri: `data:${mime};base64,${clean.toString('base64')}`, megapixels: ((metadata.width || 0) * (metadata.height || 0)) / FAL_MEGAPIXEL };
  }
  const resized = sharp(input)
    .rotate()
    .resize({ width: INPUT_MAX_LONG_SIDE, height: INPUT_MAX_LONG_SIDE, fit: 'inside', withoutEnlargement: true });
  // Keep an alpha channel lossless; everything else goes JPEG to keep the
  // request body small.
  const mime = metadata.hasAlpha ? 'image/png' : 'image/jpeg';
  const { data, info } = await (metadata.hasAlpha ? resized.png() : resized.jpeg({ quality: 90 }))
    .toBuffer({ resolveWithObject: true });
  return { dataUri: `data:${mime};base64,${data.toString('base64')}`, megapixels: (info.width * info.height) / FAL_MEGAPIXEL };
}

// The first image URL in a fal.ai image result. Curated models answer
// `{ images: [{ url }] }`. Some listed endpoints answer `{ image: { url } }`
// or a bare image string.
const firstImageUrl = (result) => {
  const fromList = Array.isArray(result?.images) ? result.images[0]?.url : null;
  if (typeof fromList === 'string' && fromList.trim()) return fromList;
  const image = result?.image;
  if (typeof image === 'string' && image.trim()) return image;
  if (typeof image?.url === 'string' && image.url.trim()) return image.url;
  return null;
};

/**
 * The prompt text fal receives (the image-role prose plus the negative folded in
 * as "Avoid:") and the record of what PortOS added (#11317). Shared by the
 * render and the compose preview.
 */
export function falImageSentPrompt({ family, prompt = '', negativePrompt, inputImages, initImageStrength, promptAdditions = [] }) {
  const roles = attachedImageRoles({
    hasInitImage: Boolean(inputImages.initPath), initImageStrength, referenceCount: inputImages.referencePaths.length,
  });
  const fullPrompt = roles ? `${prompt.trim()}\n\n${roles}` : prompt.trim();
  return {
    fullPrompt,
    record: sentPromptRecord({
      // A listed model has no curated family: fold the same "Avoid:" line the
      // request builder would. The paid body is still built from its schema.
      sentPrompt: family
        ? buildFalImageRequest({ modelId: family.textEndpoint, prompt: fullPrompt, negativePrompt }).body.prompt
        : appendFalAvoid(fullPrompt, negativePrompt),
      carried: carriedPromptAdditions({ promptAdditions }),
      added: [promptAddition('image-roles', 'How to read the attached images', fullPrompt.slice(prompt.trim().length)),
        promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', negativePrompt)],
    }),
  };
}

export const generateImage = (params) => runner.prepare(params, generateImagePrepared);

async function generateImagePrepared({
  promptAdditions = [],
  model, prompt = '', negativePrompt, width, height, seed,
  initImagePath, initImageStrength, referenceImagePaths = [],
  visualConditioning = null,
  jobId, reviewedReferenceSnapshot = null,
  cleanC2PA = false,
  denoise = false,
  apiKey: providedApiKey = null,
  settings = null,
}) {
  // The ingestion instant `renderTimingFields` measures from — see
  // lib/renderTiming.js.
  const renderStartedAtMs = Date.now();
  await ensureDir(PATHS.images);

  // Curated families are priced offline and never consult the live list.
  // Anything else must be on the loaded list, and its OpenAPI must expose a
  // prompt, before a job exists: a paid POST is never the place that discovers
  // a bad id.
  const requested = (typeof model === 'string' && model.trim()) ? model.trim() : FAL_IMAGE_DEFAULT_MODEL;
  const family = falImageFamily(requested);
  let listedSchema = null;
  if (!family) {
    await falCatalog.assertFalImageModelAvailable(requested);
    listedSchema = await falCatalog.falImageInputSchema(requested).catch((err) => {
      if (err instanceof ServerError) throw err;
      throw new ServerError(`fal.ai could not describe "${requested}"`, { status: 400, code: 'FAL_IMAGE_SCHEMA_UNSUPPORTED' });
    });
  }

  // Re-anchored to the allowed input roots and capped to THIS model's
  // reference limit (14 / 10 / 9) — see inputImages.js. A listed model stays
  // on the catalog floor.
  const inputImages = resolveInputImages({
    mode: MODE, initImagePath, referenceImagePaths, modelId: family ? family.textEndpoint : requested,
  });
  if (cloudPromptRequired(MODE, inputImages.paths.length > 0) && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (listedSchema) {
    const imageCount = inputImages.paths.length;
    if (imageCount && !listedSchema.images) {
      throw new ServerError(
        `fal.ai model "${requested}" does not take reference images — choose an edit model such as fal-ai/nano-banana-pro/edit`,
        { status: 400, code: 'FAL_IMAGE_REFERENCES_UNSUPPORTED' },
      );
    }
    if (!imageCount && listedSchema.images?.required) {
      throw new ServerError(`fal.ai model "${requested}" requires reference images`, { status: 400, code: 'FAL_IMAGE_REFERENCES_REQUIRED' });
    }
  }

  // Never threaded through job params (they persist in plaintext) — resolved
  // from live settings at dispatch, same as videoGen/fal.js.
  const effectiveSettings = settings || (providedApiKey ? null : await getSettings().catch(() => null));
  const apiKey = providedApiKey || resolveFalApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError(noKeyReason, { status: 400, code: 'FAL_NOT_CONFIGURED' });
  }

  const endpointId = family ? (inputImages.paths.length ? family.editEndpoint : family.textEndpoint) : requested;
  const { fullPrompt, record: sentRecord } = falImageSentPrompt({ family, prompt, negativePrompt, inputImages, initImageStrength, promptAdditions });
  const meta = runner.jobMeta({
    jobId, prompt, negativePrompt, width, height, inputImages, visualConditioning, sentRecord,
    // The endpoint that actually rendered (text vs /edit), plus the family the
    // user chose — a gallery reader should not have to re-derive either.
    modelFields: { model: endpointId, ...(family ? { modelFamily: family.id } : {}) },
  });
  const reviewedReferenceBytes = await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, inputImages.initPath, inputImages.referencePaths);
  return runner.start({
    meta, renderStartedAtMs, model: endpointId, status: 'Submitting to fal.ai…',
    run: (job) => runFal(job, jobId, {
      apiKey, family, listedSchema, requested, fullPrompt, negativePrompt, width, height, seed,
      inputPaths: inputImages.paths, reviewedReferenceBytes, meta, cleanC2PA, denoise,
    }),
  });
}

function formatStepFailure(step, errOrReason) {
  const msg = typeof errOrReason === 'string' ? errOrReason : (errOrReason?.message || String(errOrReason));
  const prefix = `fal.ai ${step} failed:`;
  if (msg.startsWith(prefix)) return msg;
  if (step === 'download' && /fal\.ai (image )?download failed:/i.test(msg)) {
    return msg.replace(/fal\.ai (image )?download failed:/i, prefix);
  }
  if (step === 'reference upload' && /fal\.ai (reference )?upload (failed|could not start|timed out):/i.test(msg)) {
    return msg.replace(/fal\.ai (reference )?upload (failed|could not start|timed out):/i, prefix);
  }
  return `${prefix} ${msg}`;
}

async function runFal(job, jobId, {
  apiKey, family, listedSchema, requested, fullPrompt, negativePrompt, width, height, seed,
  inputPaths, reviewedReferenceBytes, meta, cleanC2PA = false, denoise = false,
}) {
  const entry = runner.track(jobId, createFalRequestEntry(apiKey));
  const deadline = Date.now() + FAL_IMAGE_TIMEOUT_MS;
  let currentStep = inputPaths.length ? 'input encoding' : 'submit';
  try {
    const encoded = [];
    // A reviewed edit's snapshot leads (no init image); later inputs are read from disk.
    for (const [index, path] of inputPaths.entries()) encoded.push(await encodeInputImage(path, index === 0 ? reviewedReferenceBytes : null));
    if (entry.aborted) return finalizeCanceled(job, jobId);

    let imageUrls = [];
    if (encoded.length > 0) {
      currentStep = 'reference upload';
      broadcastSse(job, {
        type: 'status',
        message: encoded.length === 1 ? 'Uploading reference image…' : 'Uploading reference images…',
      });
      const uploadStepController = new AbortController();
      const onJobAbort = () => uploadStepController.abort(entry.controller.signal.reason);
      if (entry.controller.signal.aborted) onJobAbort();
      else entry.controller.signal.addEventListener('abort', onJobAbort, { once: true });
      try {
        imageUrls = await Promise.all(
          encoded.map((e) => uploadReferenceImage({
            apiKey,
            dataUri: e.dataUri,
            signal: uploadStepController.signal,
            deadline,
          })),
        );
      } catch (uploadErr) {
        uploadStepController.abort(uploadErr);
        throw uploadErr;
      } finally {
        entry.controller.signal.removeEventListener('abort', onJobAbort);
      }
      if (entry.aborted) return finalizeCanceled(job, jobId);
    }

    currentStep = 'submit';
    const request = family
      ? buildFalImageRequest({
        modelId: family.textEndpoint,
        prompt: fullPrompt,
        negativePrompt,
        width,
        height,
        seed,
        imageUrls,
        inputMegapixels: encoded.reduce((sum, e) => sum + e.megapixels, 0),
      })
      : buildListedFalImageRequest({
        modelId: requested, schema: listedSchema, prompt: fullPrompt, negativePrompt, width, height, seed, imageUrls,
      });
    if (!request) throw new Error(`fal.ai request for ${requested} could not be built`);
    // Cancelled while the inputs were being encoded or uploaded: nothing was submitted,
    // so there is nothing to pay for or cancel remotely.
    if (entry.aborted) return finalizeCanceled(job, jobId);

    const submitted = await submitFalRequest({ apiKey, modelId: request.endpointId, body: request.body });
    entry.cancelUrl = submitted.cancel_url;
    meta.falRequestId = submitted.request_id;
    currentStep = 'poll';
    broadcastSse(job, { type: 'status', message: 'Queued at fal.ai…' });

    const polled = await awaitFalCompletion({
      entry, statusUrl: submitted.status_url, apiKey, deadline, timeoutMs: FAL_IMAGE_TIMEOUT_MS,
      onPoll: () => imageGenEvents.emit('activity', { generationId: jobId }),
      onStatus: (status) => broadcastSse(job, {
        type: 'status', message: status === 'IN_PROGRESS' ? 'Rendering…' : 'Queued at fal.ai…',
      }),
    });
    if (polled.outcome === 'canceled') return finalizeCanceled(job, jobId);
    if (polled.outcome === 'failed') return finalizeJobFailure(job, jobId, null, formatStepFailure('poll', polled.reason));

    currentStep = 'download';
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

    const actualSeed = Number.isInteger(result?.seed) ? result.seed : (request.body.seed ?? null);
    await runner.publish({
      job, entry, bytes, meta, cleanC2PA, denoise,
      sidecarFields: {
        ...(request.body.aspect_ratio ? { aspectRatio: request.body.aspect_ratio } : {}),
        ...(request.resolution ? { resolution: request.resolution } : {}),
        ...(actualSeed != null ? { seed: actualSeed } : {}),
        // An ESTIMATE from the catalog's published prices — fal.ai bills the
        // account; this only lets a gallery record say roughly what it cost.
        estimatedCostUsd: request.estimatedCostUsd,
      },
      doneNote: `fal ${request.endpointId}, ${request.estimatedCostUsd == null ? 'price unknown' : `~${request.estimatedCostUsd}`}`,
    });
    if (job.status === 'complete') void autoDeleteHostedCopy('fal', 'image', meta.filename, { apiKey });
  } catch (err) {
    await runner.failRun(job, entry, formatStepFailure(currentStep, err));
  }
}

// Test-only handles.
export const _internals = {
  encodeInputImage,
  firstImageUrl,
  uploadReferenceImage,
  inflightUploads,
  completedUploadCache,
  referenceUploadCache: completedUploadCache,
  uploadGate,
  resetReferenceUploadCache: () => {
    for (const entry of inflightUploads.values()) {
      entry.controller?.abort();
    }
    inflightUploads.clear();
    for (const entry of completedUploadCache.values()) {
      if (entry?.timer) clearTimeout(entry.timer);
    }
    completedUploadCache.clear();
  },
};
