import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
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
  RUNWAY_IMAGE_DEFAULT_MODEL, getRunwayImageModel, buildRunwayImageRequest, runwayReferenceTags,
} from '../../lib/runwayImageModels.js';
import {
  broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer, dispatchTerminalEvent,
} from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import {
  awaitRunwayTask, cancelRunwayTask, createRunwayTaskEntry, resolveRunwayApiKey, submitRunwayTask,
} from '../runwayApi.js';
import { IMAGE_GEN_MODE, describeFidelity } from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { rejectDegenerateFrame } from './frameGuard.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

const MODE = IMAGE_GEN_MODE.RUNWAY;
const RUNWAY_IMAGE_TIMEOUT_MS = (() => {
  const n = Number(process.env.RUNWAY_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
})();
const RUNWAY_IMAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const jobs = new Map();
const activeRequests = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);
const preparations = createMediaJobPreparation();

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error('imageGen/runway.cancel requires a jobId — use cancelAll() to terminate every in-flight render');
  }
  const pending = preparations.cancel(jobId);
  if (pending) return pending;
  const entry = activeRequests.get(jobId);
  if (!entry) return false;
  entry.aborted = true;
  entry.controller.abort();
  void cancelRunwayTask(entry);
  return true;
};

export const cancelAll = () => {
  const ids = [...preparations.ids(), ...activeRequests.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

const noKeyReason = 'No Runway credential configured — add it in Settings → Credentials or set RUNWAYML_API_SECRET';
// This probe confirms configuration only; never test credentials with a paid render.
export async function checkConnection({ model = RUNWAY_IMAGE_DEFAULT_MODEL } = {}) {
  const apiKey = resolveRunwayApiKey(await getSettings());
  return { connected: Boolean(apiKey), mode: MODE, model, ...(apiKey ? {} : { reason: noKeyReason }) };
}

export function runwayImageSentPrompt({ prompt = '', negativePrompt, inputImages, initImageStrength, visualConditioning, modelId = RUNWAY_IMAGE_DEFAULT_MODEL, promptAdditions = [] }) {
  const references = runwayReferenceTags(inputImages.paths.map((path) => {
    const asset = visualConditioning?.assets?.find((item) => item.filename === basename(path));
    return { filename: basename(path), ...(asset || {}), path };
  }));
  const roles = references.map((ref, index) => {
    const role = ref.path === inputImages.initPath
      ? `source image to edit — ${describeFidelity(initImageStrength)}`
      : ref.role || 'visual reference';
    return `${getRunwayImageModel(modelId)?.referenceTags ? `@${ref.tag}` : `Image ${index + 1}`}: ${role}${ref.label ? ` for ${ref.label}` : ''}.`;
  }).join('\n');
  const added = [promptAddition('reference-tags', 'Runway reference image roles', roles), promptAddition('avoid', 'Negative prompt, sent as "Avoid:"', negativePrompt ? `Avoid: ${negativePrompt}` : '')];
  const fullPrompt = [prompt, ...added.map((item) => item?.text).filter(Boolean)].join('\n\n');
  return { fullPrompt, references, record: sentPromptRecord({ sentPrompt: fullPrompt, carried: carriedPromptAdditions({ promptAdditions }), added }) };
}

async function encodeInputImage(path, reviewedBytes = null) {
  const bytes = reviewedBytes || await readFile(path);
  const mime = detectImageFormat(bytes)?.mime;
  const uri = mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
  // Runway's 5 MB ceiling applies to the encoded URI, including base64 overhead.
  if (!uri || Buffer.byteLength(uri) > 5_000_000) throw new ServerError('Runway reference data URIs must be images no larger than 5 MB after base64 encoding', { status: 400, code: 'RUNWAY_IMAGE_INPUT_INVALID' });
  return uri;
}

export const generateImage = (params) => preparations.run(params, generateImagePrepared);

async function generateImagePrepared({
  promptAdditions = [],
  model, resolution, ratio, prompt = '', negativePrompt, width, height, seed,
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
  const family = getRunwayImageModel(model || RUNWAY_IMAGE_DEFAULT_MODEL);
  if (!family) {
    throw new ServerError(`Runway Imagegen has no model "${model}"`, { status: 400, code: 'RUNWAY_IMAGE_MODEL_UNKNOWN' });
  }
  const inputImages = resolveInputImages({
    mode: MODE, initImagePath, referenceImagePaths, modelId: family.id,
  });
  if (cloudPromptRequired(MODE, inputImages.paths.length > 0) && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // Resolve the shared credential at dispatch; keys never enter persisted job params.
  const effectiveSettings = settings || (providedApiKey ? null : await getSettings().catch(() => null));
  const apiKey = providedApiKey || resolveRunwayApiKey(effectiveSettings);
  if (!apiKey) {
    throw new ServerError(noKeyReason, { status: 400, code: 'RUNWAY_NOT_CONFIGURED' });
  }

  const endpointId = family.id;
  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  if (inputImages.paths.length !== (initImagePath ? 1 : 0) + referenceImagePaths.length) throw new ServerError('Runway reference inputs are unavailable or exceed the selected model’s reference limit', { status: 400, code: 'RUNWAY_IMAGE_INPUT_INVALID' });
  const { fullPrompt, references, record: sentRecord } = runwayImageSentPrompt({ prompt, negativePrompt, inputImages, initImageStrength, visualConditioning, modelId: family.id, promptAdditions });
  if (fullPrompt.length > family.promptMaxChars) {
    throw new ServerError(
      `Runway's complete prompt is ${fullPrompt.length}/${family.promptMaxChars} characters: ${prompt.length} supplied, plus ${fullPrompt.length - prompt.length} from reference tags and the negative prompt. Shorten the supplied or negative prompt; the full text is available in Show full prompt. Nothing was submitted or truncated.`,
      { status: 400, code: 'RUNWAY_IMAGE_PROMPT_TOO_LONG' },
    );
  }
  const request = buildRunwayImageRequest({ modelId: family.id, prompt: fullPrompt, resolution, ratio, width, height, seed, referenceImages: references.map((ref) => ({ uri: '(validated input)', tag: ref.tag })) });

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: MODE,
    model: endpointId,
    ratio: request.body.ratio, resolution: request.resolution,
    referenceTags: references.map(({ path: _path, ...ref }) => ref),
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

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] Runway (${endpointId})`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
  broadcastSse(job, { type: 'status', message: 'Submitting to Runway…' });
  runRunway(job, jobId, {
    apiKey, request, references, family, reviewedReferenceBytes,
    outputPath, filename, meta, cleanC2PA, denoise,
  }).catch((err) => {
    console.error(`❌ Runway image run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/images/${filename}`, generationId: jobId,
    mode: MODE,
    status: 'running',
  };
}

async function runRunway(job, jobId, {
  apiKey, request, references, family, reviewedReferenceBytes,
  outputPath, filename, meta, cleanC2PA = false, denoise = false,
}) {
  const entry = createRunwayTaskEntry(apiKey);
  entry.aborted = preparations.take(jobId);
  activeRequests.set(jobId, entry);
  const deadline = Date.now() + RUNWAY_IMAGE_TIMEOUT_MS;
  let wroteOutput = false;
  try {
    const referenceImages = [];
    // A reviewed edit's snapshot leads (no init image); later references are read from disk.
    for (const [index, ref] of references.entries()) referenceImages.push({ uri: await encodeInputImage(ref.path, index === 0 ? reviewedReferenceBytes : null), ...(family.referenceTags ? { tag: ref.tag } : {}) });
    if (entry.aborted) return finalizeCanceled(job, jobId);
    entry.taskId = await submitRunwayTask({ apiKey, endpoint: 'text_to_image', body: { ...request.body, ...(referenceImages.length ? { referenceImages } : {}) }, signal: entry.controller.signal });
    // THROTTLED waits on this accepted task. A failed/moderated task is terminal, never resubmitted.
    const polled = await awaitRunwayTask({
      entry, apiKey, deadline, timeoutMs: RUNWAY_IMAGE_TIMEOUT_MS, verbatimFailure: true,
      onPoll: () => imageGenEvents.emit('activity', { generationId: jobId }),
      onStatus: (status) => broadcastSse(job, { type: 'status', message: status === 'RUNNING' ? 'Rendering…' : status === 'THROTTLED' ? 'Waiting for Runway model capacity…' : 'Queued at Runway…' }),
    });
    if (polled.outcome === 'canceled') return finalizeCanceled(job, jobId);
    if (polled.outcome === 'failed') return finalizeJobFailure(job, jobId, null, polled.reason);

    const bytes = await withAbortTimeout(RUNWAY_IMAGE_DOWNLOAD_TIMEOUT_MS, async (timeoutSignal) => {
      const signal = anyAbortSignal([timeoutSignal, entry.controller.signal]);
      const response = await fetchWithTimeout(polled.outputUrl, { signal }, RUNWAY_IMAGE_DOWNLOAD_TIMEOUT_MS);
      if (!response.ok) throw new Error(`Runway image download failed: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    });
    if (entry.aborted) return finalizeCanceled(job, jobId);

    await withBackupAssetPublication(async () => {
      if (entry.aborted) return finalizeCanceled(job, jobId);
      try {
        const format = detectImageFormat(bytes)?.format;
        if (!format) return finalizeJobFailure(job, jobId, null, 'Runway returned a file that is not an image');
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
        const actualSeed = request.body.seed ?? null;
        await atomicWrite(sidecar, {
          ...meta,
          ...(request.body.ratio ? { aspectRatio: request.body.ratio } : {}),
          ...(request.resolution ? { resolution: request.resolution } : {}),
          ...(actualSeed != null ? { seed: actualSeed } : {}),
          estimatedCostUsd: request.estimatedCostUsd,
          estimatedCredits: request.estimatedCredits,
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
        console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (Runway ${request.body.model}, ${request.estimatedCostUsd == null ? 'price varies' : `~$${request.estimatedCostUsd}`})`);
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
    await cancelRunwayTask(entry);
    if (entry.aborted) return finalizeCanceled(job, jobId);
    finalizeJobFailure(job, jobId, null, `Runway image generation failed: ${err?.message || err}`, { force: true });
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeRequests,
  label: 'Runway image generation',
  events: imageGenEvents,
  failedPayload: (jobId, reason) => ({ mode: MODE, generationId: jobId, error: reason }),
});
const finalizeCanceled = finalizeJobFailure.canceled;

