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

import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  HIGGSFIELD_IMAGE_DEFAULT_MODEL, buildHiggsfieldImageRequest, higgsfieldImageFamily,
} from '../../lib/higgsfieldImageModels.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
import {
  awaitHiggsfieldRequest, cancelHiggsfieldRequest, createHiggsfieldRequestEntry, resolveHiggsfieldApiKey,
  submitHiggsfieldRequest, uploadHiggsfieldImage,
} from '../higgsfieldApi.js';
import { IMAGE_GEN_MODE, attachedImageRoles } from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { createHostedImageJobRunner } from './hostedJobRunner.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

const MODE = IMAGE_GEN_MODE.HIGGSFIELD;
const HIGGSFIELD_IMAGE_TIMEOUT_MS = (() => {
  const n = Number(process.env.HIGGSFIELD_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
})();
const HIGGSFIELD_IMAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const runner = createHostedImageJobRunner({ mode: MODE, provider: 'Higgsfield', cancelRemote: cancelHiggsfieldRequest });
export const { getActiveJob, getActiveJobs, attachSseClient, cancel, cancelAll } = runner;
const { finalizeJobFailure, finalizeCanceled } = runner;

const noKeyReason = 'No Higgsfield credential configured — add it in Settings → Credentials or set HIGGSFIELD_API_KEY (KEY_ID:KEY_SECRET)';

// Configuration only: Higgsfield has no free authenticated read, and a paid render is never a probe.
export async function checkConnection({ model = HIGGSFIELD_IMAGE_DEFAULT_MODEL } = {}) {
  const apiKey = resolveHiggsfieldApiKey(await getSettings().catch(() => null));
  const family = higgsfieldImageFamily(model) || higgsfieldImageFamily(HIGGSFIELD_IMAGE_DEFAULT_MODEL);
  return { connected: Boolean(apiKey), mode: MODE, model: family.label, modelId: family.textEndpoint, ...(apiKey ? {} : { reason: noKeyReason }) };
}

/**
 * The exact text Higgsfield receives and the record of what PortOS added
 * (#11317). Shared by the render and the compose preview; it also runs the
 * request builder, so an over-limit prompt refuses before anything is queued.
 */
export function higgsfieldImageSentPrompt({ family, prompt = '', negativePrompt, inputImages, initImageStrength, promptAdditions = [], width, height }) {
  const roles = attachedImageRoles({
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

  const { fullPrompt, request, record: sentRecord } = higgsfieldImageSentPrompt({
    family, prompt, negativePrompt, inputImages, initImageStrength, promptAdditions, width, height,
  });
  const meta = runner.jobMeta({
    jobId, prompt, negativePrompt, width, height, inputImages, visualConditioning, sentRecord,
    modelFields: {
      model: request.endpointId,
      modelFamily: family.id,
      ...(request.body.aspect_ratio ? { aspectRatio: request.body.aspect_ratio } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
    },
  });
  const reviewedReferenceBytes = await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, inputImages.initPath, inputImages.referencePaths);
  return runner.start({
    meta, renderStartedAtMs, model: request.endpointId, status: 'Submitting to Higgsfield…',
    run: (job) => runHiggsfield(job, jobId, {
      apiKey, family, fullPrompt, negativePrompt, width, height, seed, inputImages, reviewedReferenceBytes,
      meta, cleanC2PA, denoise,
    }),
  });
}

async function runHiggsfield(job, jobId, {
  apiKey, family, fullPrompt, negativePrompt, width, height, seed, inputImages, reviewedReferenceBytes,
  meta, cleanC2PA = false, denoise = false,
}) {
  const entry = runner.track(jobId, createHiggsfieldRequestEntry(apiKey));
  const deadline = Date.now() + HIGGSFIELD_IMAGE_TIMEOUT_MS;
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

    const bytes = await runner.download(entry, polled.outputUrl, { timeoutMs: HIGGSFIELD_IMAGE_DOWNLOAD_TIMEOUT_MS, label: 'Higgsfield image' });
    if (entry.aborted) return finalizeCanceled(job, jobId);

    await runner.publish({
      job, entry, bytes, meta, cleanC2PA, denoise,
      sidecarFields: { ...(request.body.seed != null ? { seed: request.body.seed } : {}), estimatedCostUsd: null },
      doneNote: `Higgsfield ${request.endpointId}`,
    });
    if (job.status === 'complete') void autoDeleteHostedCopy('higgsfield', 'image', meta.filename, { apiKey });
  } catch (err) {
    await runner.failRun(job, entry, `Higgsfield image generation failed: ${err?.message || err}`);
  }
}
