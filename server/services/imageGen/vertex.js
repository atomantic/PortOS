/**
 * Image Gen — Google Cloud Vertex AI provider (Gemini image models and Imagen 4).
 *
 * Same job/SSE/event contract as `fal.js` and `higgsfield.js`, so the media
 * queue runs it on the parallel cloud lane. Vertex answers synchronously: one
 * generateContent (Gemini) or predict (Imagen) call returns the image inline,
 * so there is no queue to poll and nothing to delete remotely afterwards. Input
 * images travel inline as base64. The catalog and request builder live in
 * `lib/vertexImageModels.js`; auth and endpoints in `services/vertexApi.js`.
 *
 * Money: every call is billed. The dispatcher refuses unless
 * `imageGen.vertex.enabled` is on, `checkConnection` only makes a free model
 * read, and the model is validated against the catalog. The credential is
 * shared with the video backend and re-resolved at dispatch, never persisted in
 * queue params.
 */

import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { basename, join } from 'path';
import sharp from 'sharp';
import { atomicWrite, detectImageFormat, ensureDir, PATHS, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import { VERTEX_IMAGE_DEFAULT_MODEL, buildVertexImageRequest, vertexImageFamily } from '../../lib/vertexImageModels.js';
import {
  broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer, dispatchTerminalEvent,
} from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import { checkVertexModel, resolveVertexConfig, vertexInlineImage, vertexModelUrl, vertexPost } from '../vertexApi.js';
import { IMAGE_GEN_MODE, describeFidelity, visualReferenceRole } from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { rejectDegenerateFrame } from './frameGuard.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

const MODE = IMAGE_GEN_MODE.VERTEX;
const VERTEX_IMAGE_TIMEOUT_MS = (() => {
  const n = Number(process.env.VERTEX_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
})();
// Up to 14 inputs ride in one JSON body, so a large photo is downscaled first.
const INPUT_MAX_LONG_SIDE = 2048;
const INPUT_MAX_BYTES = 4 * 1024 * 1024;
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

// A synchronous call cannot be canceled remotely once sent; aborting stops the
// wait and discards the result (still billed, so the run is unsettled).
export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error('imageGen/vertex.cancel requires a jobId — use cancelAll() to terminate every in-flight render');
  }
  const pending = preparations.cancel(jobId);
  if (pending) return pending;
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.controller.abort();
  return true;
};

export const cancelAll = () => {
  const ids = [...preparations.ids(), ...activeRequests.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

const noKeyReason = 'No Vertex AI credential configured — add an API key or service account JSON in Settings → Credentials (Google Vertex AI) or set VERTEX_API_KEY';

/** Free probe: the credential authenticates and reaches the chosen model. Never renders. */
export async function checkConnection({ model = VERTEX_IMAGE_DEFAULT_MODEL } = {}) {
  const family = vertexImageFamily(model) || vertexImageFamily(VERTEX_IMAGE_DEFAULT_MODEL);
  const base = { mode: MODE, model: family.label, modelId: family.id };
  let config;
  try {
    config = resolveVertexConfig(await getSettings().catch(() => null));
  } catch (err) {
    return { ...base, connected: false, reason: err.message };
  }
  if (!config) return { ...base, connected: false, reason: noKeyReason };
  const probe = await checkVertexModel(config, family.id, { location: family.location });
  return { ...base, connected: probe.ok, ...(probe.ok ? {} : { reason: probe.reason }) };
}

function imageRoleLines({ hasInitImage, initImageStrength, referenceCount }) {
  if (hasInitImage) {
    return [`The first attached image is the source image to edit — ${describeFidelity(initImageStrength)}.`,
      ...(referenceCount ? [`The remaining attached ${referenceCount === 1 ? 'image is' : 'images are'} ${visualReferenceRole(referenceCount)}.`] : [])].join('\n\n');
  }
  return referenceCount ? `Use the attached ${referenceCount === 1 ? 'image' : 'images'} as ${visualReferenceRole(referenceCount)}.` : '';
}

/**
 * The exact text Vertex receives and the record of what PortOS added (#11317).
 * Shared by the render and the compose preview; it also runs the request
 * builder, so an unsupported input refuses before anything is queued.
 */
export function vertexImageSentPrompt({ family, prompt = '', negativePrompt, inputImages, initImageStrength, promptAdditions = [], width, height }) {
  const roles = imageRoleLines({
    hasInitImage: Boolean(inputImages.initPath), initImageStrength, referenceCount: inputImages.referencePaths.length,
  });
  const fullPrompt = [String(prompt ?? '').trim(), roles].filter(Boolean).join('\n\n');
  let request;
  try {
    request = buildVertexImageRequest({
      modelId: family.id, prompt: fullPrompt, negativePrompt, width, height,
      images: inputImages.paths.map(() => ({ mimeType: 'image/png', data: '' })),
    });
  } catch (err) {
    throw new ServerError(err.message, { status: 400, code: err.code || 'VERTEX_IMAGE_INPUT_INVALID' });
  }
  const sentPrompt = family.kind === 'gemini' ? request.body.contents[0].parts[0].text : request.body.instances[0].prompt;
  return {
    fullPrompt,
    request,
    record: sentPromptRecord({
      sentPrompt,
      carried: carriedPromptAdditions({ promptAdditions }),
      added: [promptAddition('image-roles', 'How to read the attached images', roles),
        promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', negativePrompt)],
    }),
  };
}

async function encodeInputImage(filePath, reviewedBytes = null) {
  const input = reviewedBytes || filePath;
  const metadata = await sharp(input).metadata();
  const longSide = Math.max(metadata.width || 0, metadata.height || 0);
  if (longSide <= INPUT_MAX_LONG_SIDE && (metadata.size ?? 0) <= INPUT_MAX_BYTES && ['png', 'jpeg', 'webp'].includes(metadata.format)) {
    return vertexInlineImage(reviewedBytes || await readFile(filePath));
  }
  const resized = sharp(input).rotate()
    .resize({ width: INPUT_MAX_LONG_SIDE, height: INPUT_MAX_LONG_SIDE, fit: 'inside', withoutEnlargement: true });
  return vertexInlineImage(await (metadata.hasAlpha ? resized.png() : resized.jpeg({ quality: 90 })).toBuffer());
}

/** The first image a response carries, or `{ reason }` explaining why there is none. */
function responseImage(family, payload) {
  if (family.kind === 'imagen') {
    const prediction = Array.isArray(payload?.predictions) ? payload.predictions.find((p) => typeof p?.bytesBase64Encoded === 'string') : null;
    if (prediction) return { bytes: Buffer.from(prediction.bytesBase64Encoded, 'base64') };
    const filtered = payload?.predictions?.find?.((p) => typeof p?.raiFilteredReason === 'string')?.raiFilteredReason;
    return { reason: `Vertex AI returned no image${filtered ? `: ${filtered.slice(0, 300)}` : ' (blocked by its safety filter)'}` };
  }
  const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
  const part = candidate?.content?.parts?.find?.((p) => typeof p?.inlineData?.data === 'string');
  if (part) return { bytes: Buffer.from(part.inlineData.data, 'base64') };
  const blocked = payload?.promptFeedback?.blockReason;
  const finish = candidate?.finishReason;
  const said = candidate?.content?.parts?.find?.((p) => typeof p?.text === 'string')?.text;
  const why = blocked ? `prompt blocked (${blocked})` : finish && finish !== 'STOP' ? `finish reason ${finish}` : said ? `the model answered "${said.replace(/\s+/g, ' ').slice(0, 200)}"` : 'no image part';
  return { reason: `Vertex AI returned no image: ${why}` };
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
  settings = null,
}) {
  const renderStartedAtMs = Date.now();
  await ensureDir(PATHS.images);
  const family = vertexImageFamily(model || VERTEX_IMAGE_DEFAULT_MODEL);
  if (!family) {
    throw new ServerError(`Vertex AI Imagegen has no model "${model}"`, { status: 400, code: 'VERTEX_IMAGE_MODEL_UNKNOWN' });
  }
  const inputImages = resolveInputImages({ mode: MODE, initImagePath, referenceImagePaths, modelId: family.id });
  if (inputImages.paths.length !== (initImagePath ? 1 : 0) + referenceImagePaths.length) {
    throw new ServerError(family.maxInputImages
      ? `${family.label} takes at most ${family.maxInputImages} input image${family.maxInputImages === 1 ? '' : 's'}`
      : `${family.label} is text-to-image only; pick a Gemini image model to use input images`, { status: 400, code: 'VERTEX_IMAGE_INPUT_INVALID' });
  }
  if (cloudPromptRequired(MODE, inputImages.paths.length > 0) && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const config = resolveVertexConfig(settings || await getSettings().catch(() => null));
  if (!config) throw new ServerError(noKeyReason, { status: 400, code: 'VERTEX_NOT_CONFIGURED' });

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const { fullPrompt, request: planned, record: sentRecord } = vertexImageSentPrompt({
    family, prompt, negativePrompt, inputImages, initImageStrength, promptAdditions, width, height,
  });

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: MODE,
    model: family.id,
    ...(planned.aspectRatio ? { aspectRatio: planned.aspectRatio } : {}),
    ...(planned.imageSize ? { resolution: planned.imageSize } : {}),
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

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] Vertex AI (${family.id})`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
  broadcastSse(job, { type: 'status', message: 'Rendering on Vertex AI…' });
  runVertex(job, jobId, {
    config, family, fullPrompt, negativePrompt, width, height, seed, inputImages, reviewedReferenceBytes,
    outputPath, filename, meta, cleanC2PA, denoise,
  }).catch((err) => {
    console.error(`❌ Vertex AI image run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return { jobId, filename, path: `/data/images/${filename}`, generationId: jobId, mode: MODE, status: 'running' };
}

async function runVertex(job, jobId, {
  config, family, fullPrompt, negativePrompt, width, height, seed, inputImages, reviewedReferenceBytes,
  outputPath, filename, meta, cleanC2PA = false, denoise = false,
}) {
  const entry = { controller: new AbortController(), aborted: preparations.take(jobId) };
  activeRequests.set(jobId, entry);
  let wroteOutput = false;
  // The activity ping keeps the media queue's idle watchdog quiet during one long synchronous call.
  const heartbeat = setInterval(() => imageGenEvents.emit('activity', { generationId: jobId }), 5000);
  try {
    const signal = entry.controller.signal;
    // A reviewed edit's snapshot replaces the first input's bytes (assertSnapshotForAdapter).
    const images = [];
    for (const [index, path] of inputImages.paths.entries()) {
      images.push(await encodeInputImage(path, index === 0 ? reviewedReferenceBytes : null));
    }
    if (entry.aborted) return finalizeCanceled(job, jobId);
    const request = buildVertexImageRequest({ modelId: family.id, prompt: fullPrompt, negativePrompt, width, height, images, seed });
    const url = vertexModelUrl(config, family.id, request.method, { location: request.location });
    const payload = await vertexPost(config, url, request.body, { signal, timeoutMs: VERTEX_IMAGE_TIMEOUT_MS });
    if (entry.aborted) return finalizeCanceled(job, jobId);
    const image = responseImage(family, payload);
    if (!image.bytes) return finalizeJobFailure(job, jobId, null, image.reason);
    const bytes = image.bytes;

    await withBackupAssetPublication(async () => {
      if (entry.aborted) return finalizeCanceled(job, jobId);
      try {
        const format = detectImageFormat(bytes)?.format;
        if (!format) return finalizeJobFailure(job, jobId, null, 'Vertex AI returned a file that is not an image');
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
          ...(request.seed != null ? { seed: request.seed } : {}),
          estimatedCostUsd: request.estimatedCostUsd,
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
        console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (Vertex AI ${family.id})`);
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
  } catch (err) {
    if (entry.aborted) return finalizeCanceled(job, jobId);
    finalizeJobFailure(job, jobId, null, `Vertex AI image generation failed: ${err?.message || err}`, { force: true });
  } finally {
    clearInterval(heartbeat);
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'Vertex AI image generation',
  events: imageGenEvents,
  failedPayload: (jobId, reason) => ({ mode: MODE, generationId: jobId, error: reason }),
});
const finalizeCanceled = finalizeJobFailure.canceled;
