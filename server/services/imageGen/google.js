/**
 * Image Gen — Google Cloud Agent Platform provider (Gemini image models and Imagen 4).
 *
 * Same job/SSE/event contract as `fal.js` and `higgsfield.js`, so the media
 * queue runs it on the parallel cloud lane. Google answers synchronously: one
 * generateContent (Gemini) or predict (Imagen) call returns the image inline,
 * so there is no queue to poll and nothing to delete remotely afterwards. Input
 * images travel inline as base64. The catalog and request builder live in
 * `lib/googleImageModels.js`; auth and endpoints in `services/googleCloudApi.js`.
 *
 * Money: every call is billed. The dispatcher refuses unless
 * `imageGen.google.enabled` is on, `checkConnection` only makes a free model
 * read, and the model is validated against the catalog. The credential is
 * shared with the video backend and re-resolved at dispatch, never persisted in
 * queue params.
 */

import { readFile } from 'fs/promises';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { stripImageMetadata } from '../../lib/imageClean.js';
import { ServerError } from '../../lib/errorHandler.js';
import { GOOGLE_IMAGE_DEFAULT_MODEL, buildGoogleImageRequest, googleImageFamily } from '../../lib/googleImageModels.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import {
  checkGoogleModel, googleExpressModeRefusal, googleInlineImage, googleModelUrl, googlePost, resolveGoogleConfig,
} from '../googleCloudApi.js';
import { IMAGE_GEN_MODE, attachedImageRoles } from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { createHostedImageJobRunner } from './hostedJobRunner.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

const MODE = IMAGE_GEN_MODE.GOOGLE;
const GOOGLE_IMAGE_TIMEOUT_MS = (() => {
  const n = Number(process.env.GOOGLE_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
})();
// Up to 14 inputs ride in one JSON body, so a large photo is downscaled first.
const INPUT_MAX_LONG_SIDE = 2048;
const INPUT_MAX_BYTES = 4 * 1024 * 1024;
// A synchronous call cannot be canceled remotely once sent (no cancelRemote);
// aborting stops the wait and discards the result (still billed, so the run is unsettled).
const runner = createHostedImageJobRunner({ mode: MODE, provider: 'Google' });
export const { getActiveJob, getActiveJobs, attachSseClient, cancel, cancelAll } = runner;
const { finalizeJobFailure, finalizeCanceled } = runner;

const noKeyReason = 'No Google credential configured — add an API key or service account JSON in Settings → Credentials (Google Cloud (Agent Platform)) or set GOOGLE_CLOUD_API_KEY';

/** Free probe: the credential authenticates and reaches the chosen model. Never renders. */
export async function checkConnection({ model = GOOGLE_IMAGE_DEFAULT_MODEL } = {}) {
  const family = googleImageFamily(model) || googleImageFamily(GOOGLE_IMAGE_DEFAULT_MODEL);
  const base = { mode: MODE, model: family.label, modelId: family.id };
  let config;
  try {
    config = resolveGoogleConfig(await getSettings().catch(() => null));
  } catch (err) {
    return { ...base, connected: false, reason: err.message };
  }
  if (!config) return { ...base, connected: false, reason: noKeyReason };
  const expressRefusal = googleExpressModeRefusal(config, family);
  if (expressRefusal) return { ...base, connected: false, reason: expressRefusal };
  const probe = await checkGoogleModel(config, family.id, { location: family.location });
  return { ...base, connected: probe.ok, ...(probe.ok ? {} : { reason: probe.reason }) };
}

/**
 * The exact text Google receives and the record of what PortOS added (#11317).
 * Shared by the render and the compose preview; it also runs the request
 * builder, so an unsupported input refuses before anything is queued.
 */
export function googleImageSentPrompt({ family, prompt = '', negativePrompt, inputImages, initImageStrength, promptAdditions = [], width, height }) {
  const roles = attachedImageRoles({
    hasInitImage: Boolean(inputImages.initPath), initImageStrength, referenceCount: inputImages.referencePaths.length,
  });
  const fullPrompt = [String(prompt ?? '').trim(), roles].filter(Boolean).join('\n\n');
  let request;
  try {
    request = buildGoogleImageRequest({
      modelId: family.id, prompt: fullPrompt, negativePrompt, width, height,
      images: inputImages.paths.map(() => ({ mimeType: 'image/png', data: '' })),
    });
  } catch (err) {
    throw new ServerError(err.message, { status: 400, code: err.code || 'GOOGLE_IMAGE_INPUT_INVALID' });
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
  // sharp reports `size` only for Buffer input, so read the bytes before checking the cap.
  const input = reviewedBytes || await readFile(filePath);
  const { default: sharp } = await import('sharp');
  const metadata = await sharp(input).metadata();
  const longSide = Math.max(metadata.width || 0, metadata.height || 0);
  if (longSide <= INPUT_MAX_LONG_SIDE && input.length <= INPUT_MAX_BYTES && ['png', 'jpeg', 'webp'].includes(metadata.format)) {
    return googleInlineImage(stripImageMetadata(input).data);
  }
  const resized = sharp(input).rotate()
    .resize({ width: INPUT_MAX_LONG_SIDE, height: INPUT_MAX_LONG_SIDE, fit: 'inside', withoutEnlargement: true });
  return googleInlineImage(await (metadata.hasAlpha ? resized.png() : resized.jpeg({ quality: 90 })).toBuffer());
}

/** The first image a response carries, or `{ reason }` explaining why there is none. */
function responseImage(family, payload) {
  if (family.kind === 'imagen') {
    const prediction = Array.isArray(payload?.predictions) ? payload.predictions.find((p) => typeof p?.bytesBase64Encoded === 'string') : null;
    if (prediction) return { bytes: Buffer.from(prediction.bytesBase64Encoded, 'base64') };
    const filtered = payload?.predictions?.find?.((p) => typeof p?.raiFilteredReason === 'string')?.raiFilteredReason;
    return { reason: `Google returned no image${filtered ? `: ${filtered.slice(0, 300)}` : ' (blocked by its safety filter)'}` };
  }
  const candidate = Array.isArray(payload?.candidates) ? payload.candidates[0] : null;
  const part = candidate?.content?.parts?.find?.((p) => typeof p?.inlineData?.data === 'string');
  if (part) return { bytes: Buffer.from(part.inlineData.data, 'base64') };
  const blocked = payload?.promptFeedback?.blockReason;
  const finish = candidate?.finishReason;
  const said = candidate?.content?.parts?.find?.((p) => typeof p?.text === 'string')?.text;
  const why = blocked ? `prompt blocked (${blocked})` : finish && finish !== 'STOP' ? `finish reason ${finish}` : said ? `the model answered "${said.replace(/\s+/g, ' ').slice(0, 200)}"` : 'no image part';
  return { reason: `Google returned no image: ${why}` };
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
  settings = null,
}) {
  const renderStartedAtMs = Date.now();
  await ensureDir(PATHS.images);
  const family = googleImageFamily(model || GOOGLE_IMAGE_DEFAULT_MODEL);
  if (!family) {
    throw new ServerError(`Google Imagegen has no model "${model}"`, { status: 400, code: 'GOOGLE_IMAGE_MODEL_UNKNOWN' });
  }
  const inputImages = resolveInputImages({ mode: MODE, initImagePath, referenceImagePaths, modelId: family.id });
  if (inputImages.paths.length !== (initImagePath ? 1 : 0) + referenceImagePaths.length) {
    throw new ServerError(family.maxInputImages
      ? `${family.label} takes at most ${family.maxInputImages} input image${family.maxInputImages === 1 ? '' : 's'}`
      : `${family.label} is text-to-image only; pick a Gemini image model to use input images`, { status: 400, code: 'GOOGLE_IMAGE_INPUT_INVALID' });
  }
  if (cloudPromptRequired(MODE, inputImages.paths.length > 0) && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const config = resolveGoogleConfig(settings || await getSettings().catch(() => null));
  if (!config) throw new ServerError(noKeyReason, { status: 400, code: 'GOOGLE_NOT_CONFIGURED' });
  const expressRefusal = googleExpressModeRefusal(config, family);
  if (expressRefusal) throw new ServerError(expressRefusal, { status: 400, code: 'GOOGLE_PROJECT_REQUIRED' });

  const { fullPrompt, request: planned, record: sentRecord } = googleImageSentPrompt({
    family, prompt, negativePrompt, inputImages, initImageStrength, promptAdditions, width, height,
  });
  const meta = runner.jobMeta({
    jobId, prompt, negativePrompt, width, height, inputImages, visualConditioning, sentRecord,
    modelFields: {
      model: family.id,
      ...(planned.aspectRatio ? { aspectRatio: planned.aspectRatio } : {}),
      ...(planned.imageSize ? { resolution: planned.imageSize } : {}),
    },
  });
  const reviewedReferenceBytes = await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, inputImages.initPath, inputImages.referencePaths);
  return runner.start({
    meta, renderStartedAtMs, model: family.id, status: 'Rendering on Google…',
    run: (job) => runGoogle(job, jobId, {
      config, family, fullPrompt, negativePrompt, width, height, seed, inputImages, reviewedReferenceBytes,
      meta, cleanC2PA, denoise,
    }),
  });
}

async function runGoogle(job, jobId, {
  config, family, fullPrompt, negativePrompt, width, height, seed, inputImages, reviewedReferenceBytes,
  meta, cleanC2PA = false, denoise = false,
}) {
  const entry = runner.track(jobId, { controller: new AbortController() });
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
    const request = buildGoogleImageRequest({ modelId: family.id, prompt: fullPrompt, negativePrompt, width, height, images, seed });
    const url = googleModelUrl(config, family.id, request.method, { location: request.location });
    const payload = await googlePost(config, url, request.body, { signal, timeoutMs: GOOGLE_IMAGE_TIMEOUT_MS });
    if (entry.aborted) return finalizeCanceled(job, jobId);
    const image = responseImage(family, payload);
    if (!image.bytes) return finalizeJobFailure(job, jobId, null, image.reason);
    await runner.publish({
      job, entry, bytes: image.bytes, meta, cleanC2PA, denoise,
      sidecarFields: { ...(request.seed != null ? { seed: request.seed } : {}), estimatedCostUsd: request.estimatedCostUsd },
      doneNote: `Google ${family.id}`,
    });
  } catch (err) {
    await runner.failRun(job, entry, `Google image generation failed: ${err?.message || err}`);
  } finally {
    clearInterval(heartbeat);
  }
}
