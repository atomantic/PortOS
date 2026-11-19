import { readFile } from 'fs/promises';
import { basename } from 'path';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { detectImageFormat } from '../../lib/mimeTypes.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  RUNWAY_IMAGE_DEFAULT_MODEL, getRunwayImageModel, buildRunwayImageRequest, runwayReferenceTags,
} from '../../lib/runwayImageModels.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { getSettings } from '../settings.js';
import { autoDeleteHostedCopy } from '../hostedRenderRemoteDelete.js';
import {
  awaitRunwayTask, cancelRunwayTask, createRunwayTaskEntry, resolveRunwayApiKey, submitRunwayTask,
} from '../runwayApi.js';
import { IMAGE_GEN_MODE, describeFidelity } from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { createHostedImageJobRunner } from './hostedJobRunner.js';
import { carriedPromptAdditions, promptAddition, sentPromptRecord } from '../../lib/modelInput.js';

const MODE = IMAGE_GEN_MODE.RUNWAY;
const RUNWAY_IMAGE_TIMEOUT_MS = (() => {
  const n = Number(process.env.RUNWAY_IMAGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15 * 60 * 1000;
})();
const RUNWAY_IMAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const runner = createHostedImageJobRunner({ mode: MODE, provider: 'Runway', cancelRemote: cancelRunwayTask });
export const { getActiveJob, getActiveJobs, attachSseClient, cancel, cancelAll } = runner;
const { finalizeJobFailure, finalizeCanceled } = runner;

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

export const generateImage = (params) => runner.prepare(params, generateImagePrepared);

async function generateImagePrepared({
  promptAdditions = [],
  model, resolution, ratio, prompt = '', negativePrompt, width, height, seed,
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
  if (inputImages.paths.length !== (initImagePath ? 1 : 0) + referenceImagePaths.length) throw new ServerError('Runway reference inputs are unavailable or exceed the selected model’s reference limit', { status: 400, code: 'RUNWAY_IMAGE_INPUT_INVALID' });
  const { fullPrompt, references, record: sentRecord } = runwayImageSentPrompt({ prompt, negativePrompt, inputImages, initImageStrength, visualConditioning, modelId: family.id, promptAdditions });
  if (fullPrompt.length > family.promptMaxChars) {
    throw new ServerError(
      `Runway's complete prompt is ${fullPrompt.length}/${family.promptMaxChars} characters: ${prompt.length} supplied, plus ${fullPrompt.length - prompt.length} from reference tags and the negative prompt. Shorten the supplied or negative prompt; the full text is available in Show full prompt. Nothing was submitted or truncated.`,
      { status: 400, code: 'RUNWAY_IMAGE_PROMPT_TOO_LONG' },
    );
  }
  const request = buildRunwayImageRequest({ modelId: family.id, prompt: fullPrompt, resolution, ratio, width, height, seed, referenceImages: references.map((ref) => ({ uri: '(validated input)', tag: ref.tag })) });

  const meta = runner.jobMeta({
    jobId, prompt, negativePrompt, width, height, inputImages, visualConditioning, sentRecord,
    modelFields: {
      model: endpointId,
      ratio: request.body.ratio, resolution: request.resolution,
      referenceTags: references.map(({ path: _path, ...ref }) => ref),
    },
  });
  const reviewedReferenceBytes = await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, inputImages.initPath, inputImages.referencePaths);
  return runner.start({
    meta, renderStartedAtMs, model: endpointId, status: 'Submitting to Runway…',
    run: (job) => runRunway(job, jobId, {
      apiKey, request, references, family, reviewedReferenceBytes,
      meta, cleanC2PA, denoise,
    }),
  });
}

async function runRunway(job, jobId, {
  apiKey, request, references, family, reviewedReferenceBytes,
  meta, cleanC2PA = false, denoise = false,
}) {
  const entry = runner.track(jobId, createRunwayTaskEntry(apiKey));
  const deadline = Date.now() + RUNWAY_IMAGE_TIMEOUT_MS;
  try {
    const referenceImages = [];
    // A reviewed edit's snapshot leads (no init image); later references are read from disk.
    for (const [index, ref] of references.entries()) referenceImages.push({ uri: await encodeInputImage(ref.path, index === 0 ? reviewedReferenceBytes : null), ...(family.referenceTags ? { tag: ref.tag } : {}) });
    if (entry.aborted) return finalizeCanceled(job, jobId);
    entry.taskId = await submitRunwayTask({ apiKey, endpoint: 'text_to_image', body: { ...request.body, ...(referenceImages.length ? { referenceImages } : {}) }, signal: entry.controller.signal });
    meta.runwayTaskId = entry.taskId;
    // THROTTLED waits on this accepted task. A failed/moderated task is terminal, never resubmitted.
    const polled = await awaitRunwayTask({
      entry, apiKey, deadline, timeoutMs: RUNWAY_IMAGE_TIMEOUT_MS, verbatimFailure: true,
      onPoll: () => imageGenEvents.emit('activity', { generationId: jobId }),
      onStatus: (status) => broadcastSse(job, { type: 'status', message: status === 'RUNNING' ? 'Rendering…' : status === 'THROTTLED' ? 'Waiting for Runway model capacity…' : 'Queued at Runway…' }),
    });
    if (polled.outcome === 'canceled') return finalizeCanceled(job, jobId);
    if (polled.outcome === 'failed') return finalizeJobFailure(job, jobId, null, polled.reason);

    const bytes = await runner.download(entry, polled.outputUrl, { timeoutMs: RUNWAY_IMAGE_DOWNLOAD_TIMEOUT_MS, label: 'Runway image' });
    if (entry.aborted) return finalizeCanceled(job, jobId);

    await runner.publish({
      job, entry, bytes, meta, cleanC2PA, denoise,
      sidecarFields: {
        ...(request.body.ratio ? { aspectRatio: request.body.ratio } : {}),
        ...(request.resolution ? { resolution: request.resolution } : {}),
        ...(request.body.seed != null ? { seed: request.body.seed } : {}),
        estimatedCostUsd: request.estimatedCostUsd,
        estimatedCredits: request.estimatedCredits,
      },
      doneNote: `Runway ${request.body.model}, ${request.estimatedCostUsd == null ? 'price varies' : `~$${request.estimatedCostUsd}`}`,
    });
    if (job.status === 'complete') void autoDeleteHostedCopy('runway', 'image', meta.filename, { apiKey });
  } catch (err) {
    await runner.failRun(job, entry, `Runway image generation failed: ${err?.message || err}`);
  }
}

