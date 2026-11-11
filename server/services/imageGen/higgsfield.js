/**
 * Image Gen — Higgsfield developer API provider.
 *
 * Same job/SSE/event contract as `fal.js` and `runway.js`, so the media queue
 * runs it on the parallel cloud lane. A render with an input image uploads the
 * images to Higgsfield (the API only reads public URLs) and routes to the
 * family's edit endpoint; otherwise it calls the text-to-image endpoint. The
 * catalog and request builder live in `lib/higgsfieldImageModels.js`.
 *
 * Money: every submit is billed. The dispatcher refuses unless
 * `imageGen.higgsfield.enabled` is on, `checkConnection` never submits, and the
 * model is validated against the catalog. The key is shared with the video
 * backend and re-resolved at dispatch, never persisted in queue params.
 */

import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { randomUUID } from 'crypto';
import { basename, join } from 'path';
import sharp from 'sharp';
import { atomicWrite, detectImageFormat, ensureDir, PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { anyAbortSignal } from '../../lib/requestAbort.js';
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import {
  HIGGSFIELD_IMAGE_DEFAULT_MODEL, buildHiggsfieldImageRequest, higgsfieldImageFamily,
} from '../../lib/higgsfieldImageModels.js';
import {
  broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer, dispatchTerminalEvent,
} from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
import {
  awaitHiggsfieldRequest, cancelHiggsfieldRequest, createHiggsfieldRequestEntry, resolveHiggsfieldApiKey,
  submitHiggsfieldRequest, uploadHiggsfieldImage,
} from '../higgsfieldApi.js';
import { IMAGE_GEN_MODE, describeFidelity, visualReferenceRole } from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { rejectDegenerateFrame } from './frameGuard.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

const MODE = IMAGE_GEN_MODE.HIGGSFIELD;
const HIGGSFIELD_IMAGE_TIMEOUT_MS = (() => {
  const n = Number(process.env.HIGGSFIELD_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
})();
const HIGGSFIELD_IMAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const jobs = new Map();
const activeRequests = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};
export const getActiveJobs = () => [...activeJobs.values()];
export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

const preparations = createMediaJobPreparation();

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error('imageGen/higgsfield.cancel requires a jobId — use cancelAll() to terminate every in-flight render');
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

const noKeyReason = 'No Higgsfield credential configured — add it in Settings → Credentials or set HIGGSFIELD_API_KEY (KEY_ID:KEY_SECRET)';

// Configuration only: Higgsfield has no free authenticated read, and a paid render is never a probe.
export async function checkConnection({ model = HIGGSFIELD_IMAGE_DEFAULT_MODEL } = {}) {
  const apiKey = resolveHiggsfieldApiKey(await getSettings().catch(() => null));
  const family = higgsfieldImageFamily(model) || higgsfieldImageFamily(HIGGSFIELD_IMAGE_DEFAULT_MODEL);
  return { connected: Boolean(apiKey), mode: MODE, model: family.label, modelId: family.textEndpoint, ...(apiKey ? {} : { reason: noKeyReason }) };
}

// These models read the attached images in order and take plain-language
// direction about them, the same prose the fal.ai backend sends.
function imageRoleLines({ hasInitImage, initImageStrength, referenceCount }) {
  if (hasInitImage) {
    return [`The first attached image is the source image to edit — ${describeFidelity(initImageStrength)}.`,
      ...(referenceCount ? [`The remaining attached ${referenceCount === 1 ? 'image is' : 'images are'} ${visualReferenceRole(referenceCount)}.`] : [])].join('\n\n');
  }
  return referenceCount ? `Use the attached ${referenceCount === 1 ? 'image' : 'images'} as ${visualReferenceRole(referenceCount)}.` : '';
}

/**
 * The exact text Higgsfield receives and the record of what PortOS added
 * (#11317). Shared by the render and the compose preview; it also runs the
 * request builder, so an over-limit prompt refuses before anything is queued.
 */
export function higgsfieldImageSentPrompt({ family, prompt = '', negativePrompt, inputImages, initImageStrength, promptAdditions = [], width, height }) {
  const roles = imageRoleLines({
    hasInitImage: Boolean(inputImages.initPath), initImageStrength, referenceCount: inputImages.referencePaths.length,
  });
  const fullPrompt = [String(prompt ?? '').trim(), roles].filter(Boolean).join('\n\n');
  let request;
  try {
    request = buildHiggsfieldImageRequest({
      modelId: family.textEndpoint, prompt: fullPrompt, negativePrompt, width, height,
      imageUrls: inputImages.paths.map((_, i) => `pending:image-${i + 1}`),
    });
  } catch (err) {
    throw new ServerError(err.message, { status: 400, code: err.code || 'HIGGSFIELD_IMAGE_INPUT_INVALID' });
  }
  const folded = family.negativePrompt === 'fold';
  return {
    fullPrompt,
    request,
    record: sentPromptRecord({
      sentPrompt: request.body.prompt,
      sentNegativePrompt: request.body.negative_prompt ?? null,
      carried: carriedPromptAdditions({ promptAdditions }),
      added: [promptAddition('image-roles', 'How to read the attached images', roles),
        folded ? promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', negativePrompt) : null],
    }),
  };
}

export const generateImage = (params) => preparations.run(params, generateImagePrepared);

async function generateImagePrepared({
  promptAdditions = [],
  model, prompt = '', negativePrompt, width, height, seed,
  initImagePath, initImageStrength, referenceImagePaths = [],
  visualConditioning = null,
  jobId: providedJobId = null, reviewedReferenceSnapshot = null,
  cleanC2PA = false,
  denoise = false,
  apiKey: providedApiKey = null,
  settings = null,
}) {
  const renderStartedAtMs = Date.now();
  await ensureDir(PATHS.images);
  const family = higgsfieldImageFamily(model || HIGGSFIELD_IMAGE_DEFAULT_MODEL);
  if (!family) {
    throw new ServerError(`Higgsfield Imagegen has no model "${model}"`, { status: 400, code: 'HIGGSFIELD_IMAGE_MODEL_UNKNOWN' });
  }
  const inputImages = resolveInputImages({ mode: MODE, initImagePath, referenceImagePaths, modelId: family.textEndpoint });
  if (inputImages.paths.length !== (initImagePath ? 1 : 0) + referenceImagePaths.length) {
    throw new ServerError(family.maxInputImages
      ? `${family.label} takes at most ${family.maxInputImages} input image${family.maxInputImages === 1 ? '' : 's'}`
      : `${family.label} is text-to-image only; pick a Higgsfield model that edits`, { status: 400, code: 'HIGGSFIELD_IMAGE_INPUT_INVALID' });
  }
  if (cloudPromptRequired(MODE, inputImages.paths.length > 0) && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const effectiveSettings = settings || (providedApiKey ? null : await getSettings().catch(() => null));
  const apiKey = providedApiKey || resolveHiggsfieldApiKey(effectiveSettings);
  if (!apiKey) throw new ServerError(noKeyReason, { status: 400, code: 'HIGGSFIELD_NOT_CONFIGURED' });

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const { fullPrompt, request, record: sentRecord } = higgsfieldImageSentPrompt({
    family, prompt, negativePrompt, inputImages, initImageStrength, promptAdditions, width, height,
  });

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: MODE,
    model: request.endpointId,
    modelFamily: family.id,
    ...(request.body.aspect_ratio ? { aspectRatio: request.body.aspect_ratio } : {}),
    ...(request.resolution ? { resolution: request.resolution } : {}),
    inputProvenance: 'provider-inputs',
    initImageFilename: inputImages.initPath ? basename(inputImages.initPath) : null,
    referenceImageFilenames: inputImages.referencePaths.map(path => basename(path)),
    ...(inputImages.paths.length ? { inputImageCount: inputImages.paths.length } : {}),
    ...(visualConditioning ? { visualConditioning } : {}),
    ...sentRecord,
    createdAt: new Date().toISOString(),
  };
  const reviewedReferenceBytes = await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, inputImages.initPath, inputImages.referencePaths);
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  jobs.set(jobId, job);

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] Higgsfield (${request.endpointId})`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
  broadcastSse(job, { type: 'status', message: 'Submitting to Higgsfield…' });
  runHiggsfield(job, jobId, {
    apiKey, family, fullPrompt, negativePrompt, width, height, seed, inputImages, reviewedReferenceBytes,
    outputPath, filename, meta, cleanC2PA, denoise,
  }).catch((err) => {
    console.error(`❌ Higgsfield image run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return { jobId, filename, path: `/data/images/${filename}`, generationId: jobId, mode: MODE, status: 'running' };
}

async function runHiggsfield(job, jobId, {
  apiKey, family, fullPrompt, negativePrompt, width, height, seed, inputImages, reviewedReferenceBytes,
  outputPath, filename, meta, cleanC2PA = false, denoise = false,
}) {
  const entry = createHiggsfieldRequestEntry(apiKey);
  entry.aborted = preparations.take(jobId);
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + HIGGSFIELD_IMAGE_TIMEOUT_MS;
  let wroteOutput = false;
  try {
    const signal = entry.controller.signal;
    if (entry.aborted) {
      entry.controller.abort();
      return finalizeCanceled(job, jobId);
    }
    // A reviewed edit's snapshot replaces the first input's bytes (assertSnapshotForAdapter).
    const imageUrls = [];
    for (const [index, path] of inputImages.paths.entries()) {
      if (entry.aborted) return finalizeCanceled(job, jobId);
      imageUrls.push(await uploadHiggsfieldImage({ apiKey, path, bytes: index === 0 ? reviewedReferenceBytes : null, signal }));
    }
    if (entry.aborted) return finalizeCanceled(job, jobId);
    if (Date.now() >= deadline) throw new Error('Higgsfield image render deadline elapsed before submission');
    const request = buildHiggsfieldImageRequest({ modelId: family.textEndpoint, prompt: fullPrompt, negativePrompt, width, height, imageUrls, seed });
    const submitted = await submitHiggsfieldRequest({ apiKey, endpoint: request.endpointId, body: request.body, signal });
    entry.requestId = submitted.requestId;
    entry.cancelUrl = submitted.cancelUrl;
    meta.higgsfieldRequestId = submitted.requestId;
    const polled = await awaitHiggsfieldRequest({
      entry, apiKey, statusUrl: submitted.statusUrl, kind: 'image', deadline, timeoutMs: HIGGSFIELD_IMAGE_TIMEOUT_MS,
      onPoll: () => imageGenEvents.emit('activity', { generationId: jobId }),
      onStatus: (status) => broadcastSse(job, { type: 'status', message: status === 'in_progress' ? 'Rendering…' : 'Queued at Higgsfield…' }),
    });
    if (polled.outcome === 'canceled') return finalizeCanceled(job, jobId);
    if (polled.outcome === 'failed') return finalizeJobFailure(job, jobId, null, polled.reason);

    const bytes = await withAbortTimeout(HIGGSFIELD_IMAGE_DOWNLOAD_TIMEOUT_MS, async (timeoutSignal) => {
      const downloadSignal = anyAbortSignal([timeoutSignal, signal]);
      const response = await fetchWithTimeout(polled.outputUrl, { signal: downloadSignal }, HIGGSFIELD_IMAGE_DOWNLOAD_TIMEOUT_MS);
      if (!response.ok) throw new Error(`Higgsfield image download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    });
    if (entry.aborted) return finalizeCanceled(job, jobId);

    await withBackupAssetPublication(async () => {
      if (entry.aborted) return finalizeCanceled(job, jobId);
      try {
        const format = detectImageFormat(bytes)?.format;
        if (!format) return finalizeJobFailure(job, jobId, null, 'Higgsfield returned a file that is not an image');
        await atomicWrite(outputPath, format === 'png' ? bytes : await sharp(bytes).png().toBuffer());
        wroteOutput = true;
        if (entry.aborted) {
          await unlinkGuarded(outputPath).catch(() => {});
          return finalizeCanceled(job, jobId);
        }
        const emptyFrame = await rejectDegenerateFrame(outputPath);
        if (emptyFrame) {
          await unlinkGuarded(outputPath).catch(() => {});
          return finalizeJobFailure(job, jobId, null, emptyFrame);
        }
        const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
        await atomicWrite(sidecar, {
          ...meta,
          ...(request.body.seed != null ? { seed: request.body.seed } : {}),
          estimatedCostUsd: null,
          ...renderTimingFields(job.renderStartedAtMs),
        });
        await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode: MODE });
        if (entry.aborted) {
          await Promise.all([outputPath, sidecar].map(path => unlinkGuarded(path)));
          return finalizeCanceled(job, jobId);
        }
        job.status = 'complete';
        if (activeRequests.get(jobId) === entry) activeRequests.delete(jobId);
        activeJobs.delete(jobId);
        console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (Higgsfield ${request.endpointId})`);
        const done = { filename, path: `/data/images/${filename}` };
        dispatchTerminalEvent(
          jobId,
          () => broadcastSse(job, { type: 'complete', result: done }),
          () => imageGenEvents.emit('completed', { mode: MODE, generationId: jobId, inputProcessSettled: true, path: done.path, filename }),
        );
        closeJobAfterDelay(jobs, jobId);
      } catch (err) {
        if (wroteOutput && job.status !== 'complete') {
          await Promise.all([outputPath, join(PATHS.images, `${jobId}.metadata.json`)].map(path => unlinkGuarded(path).catch(() => {})));
        }
        throw err;
      }
    });
    if (job.status === 'complete') void autoDeleteHostedCopy('higgsfield', 'image', filename, { apiKey });
  } catch (err) {
    await cancelHiggsfieldRequest(entry);
    if (entry.aborted) return finalizeCanceled(job, jobId);
    finalizeJobFailure(job, jobId, null, `Higgsfield image generation failed: ${err?.message || err}`, { force: true });
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'Higgsfield image generation',
  events: imageGenEvents,
  failedPayload: (jobId, reason) => ({ mode: MODE, generationId: jobId, error: reason }),
});
const finalizeCanceled = finalizeJobFailure.canceled;
