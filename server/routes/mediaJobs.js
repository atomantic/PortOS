/**
 * Media Job Queue Routes — read + cancel access to the unified image/video
 * render queue. The actual enqueueing happens in /api/video-gen and
 * /api/image-gen routes; this surface lets the UI show what's pending and
 * cancel something without going through provider-specific endpoints.
 */

import { Router } from 'express';
import { isRetryNegativePromptAddition, retryPromptParts } from '../services/mediaJobQueue/retryPrompt.js';
import {
  promptFromMediaSchema,
  resumeHoldParamsSchema,
  resumeHoldBodySchema,
  EFFORT_CLEAR_SENTINEL,
  VIDEO_RETRY_BOUNDS_SCHEMA,
  IMAGE_RETRY_BOUNDS_SCHEMA,
  retryBodySchema,
  clearFailedCanceledSchema,
  videoHoldsQuerySchema,
  jobParamsSchema,
  createMediaJobQueueSchemas,
} from '../lib/mediaJobsValidation.js';
import { universeVisualProfileSchema } from '../lib/universeVisualProfileValidation.js';
import { normalizeUniverseVisualProfile } from '../lib/universeVisualProfile.js';
import { imageVisualProfileRevision } from '../services/imageGen/visualProfile.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { listJobs, listQueueJobs, getJob, cancelJob, cancelQueuedJobs, enqueueJob, removeArchivedJob, removeFailedCanceledJobs, runJobNow, listVideoHolds, resumeVideoHold, JOB_KINDS, JOB_STATUSES, MEDIA_QUEUE_SHUTTING_DOWN } from '../services/mediaJobQueue/index.js';
import { refineMediaPrompt } from '../services/mediaPromptRefiner.js';
import { saveMediaPromptExamination, listMediaPromptExaminations, getMediaPromptExamination } from '../services/mediaPromptHistory.js';
import { promptFromMedia } from '../services/mediaPromptFromMedia.js';
import { videoSegmentReplayReceiptSchema } from '../services/mediaJobQueue/videoExecution.js';
import { sanitizeJob } from '../services/mediaJobQueue/sanitizeJob.js';
import { isRemoteMediaJob } from '../services/mediaJobQueue/remoteMediaJob.js';
import { assertReactorNegativePromptSupported } from '../services/videoGen/negativePrompt.js';
import { hostedVideoRetryValidator } from '../services/videoGen/hostedSubmission.js';
import { refineImagePixelCap, PIXEL_CAP_MESSAGE } from '../lib/sharedSchemas.js';
import { CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE, VIDEO_GEN_MODE } from '../lib/generationModes.js';
import { LOCAL_IMAGEGEN_DEFAULT_MODEL } from '../lib/imageGenCapabilities.js';
import { assertLocalImageModelInputs } from '../lib/localImageModelInputs.js';
import { resolveContinuityRequest } from '../lib/videoContinuity.js';

const { listQuerySchema, refinePromptSchema, queueQuerySchema, cancelQueuedSchema } = createMediaJobQueueSchemas(JOB_KINDS, JOB_STATUSES);

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const filters = validateRequest(listQuerySchema, req.query);
  // Live jobs preserve `listJobs` order — [running, codexRunning, ...queue] —
  // so the UI reads top-to-bottom as "currently rendering, then next in line"
  // (FIFO). A single timestamp DESC sort puts later-queued jobs ahead of an
  // earlier-started running job and confuses the user.
  // Terminal jobs sort by most-recent finish so the "recent" reel surfaces
  // newest-first; the fallback chain handles canceled-while-queued jobs.
  const jobs = listJobs(filters);
  const live = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const terminal = jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
  terminal.sort((a, b) => {
    const ta = new Date(a.completedAt || a.startedAt || a.queuedAt || 0).getTime();
    const tb = new Date(b.completedAt || b.startedAt || b.queuedAt || 0).getTime();
    return tb - ta;
  });
  res.json([...live, ...terminal].map(sanitizeJob));
}));

router.get('/queue', asyncHandler(async (req, res) => {
  const filters = validateRequest(queueQuerySchema, req.query);
  res.json(listQueueJobs(filters).map(sanitizeJob));
}));

router.post('/refine-prompt', asyncHandler(async (req, res) => {
  const data = validateRequest(refinePromptSchema, req.body);
  res.json(await refineMediaPrompt(data));
}));

router.get('/prompt-history', asyncHandler(async (req, res) => {
  const { offset } = validateRequest(videoHoldsQuerySchema, req.query);
  res.json(await listMediaPromptExaminations(offset));
}));
router.get('/prompt-history/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(jobParamsSchema, req.params);
  const record = await getMediaPromptExamination(id);
  if (!record) throw new ServerError('Examination not found', { status: 404 });
  res.json(record);
}));

router.post('/prompt-from-media', asyncHandler(async (req, res) => {
  const data = validateRequest(promptFromMediaSchema, req.body);
  const result = await promptFromMedia(data);
  const source = { sourceKind: data.sourceKind, filename: data.filename, videoId: data.videoId };
  const record = await saveMediaPromptExamination(source, result);
  res.json({ ...result, examinationId: record.id });
}));

router.get('/holds', asyncHandler(async (_req, res) => {
  res.json(listVideoHolds());
}));

router.post('/holds/:holdId/resume', asyncHandler(async (req, res) => {
  const { holdId } = validateRequest(resumeHoldParamsSchema, req.params);
  validateRequest(resumeHoldBodySchema, req.body ?? {});
  if (!await resumeVideoHold(holdId)) {
    throw new ServerError('Hold no longer exists', { status: 404, code: 'NOT_FOUND' });
  }
  res.json({ resumed: true });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    // Speculative lookups (Pipeline `MediaJobThumb` hydration for old
    // panel/scene jobIds that are past the queue's 24h archive TTL) hit
    // this path constantly. Mark as `warning` so it doesn't surface as a
    // global toast/console.error via useErrorNotifications — the body is
    // unchanged, callers still get a 404 + NOT_FOUND code.
    throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND', severity: 'warning' });
  }
  res.json(sanitizeJob(job));
}));

router.post('/:id/cancel', asyncHandler(async (req, res) => {
  const result = await cancelJob(req.params.id);
  if (!result.ok) {
    // Distinguish "no such id" (404) from "exists but already terminal"
    // (409) so consumers can react appropriately — e.g. the UI doesn't
    // need to display "Not found" when the user just clicked Cancel
    // again on a job that already finished.
    const status = result.code === 'ALREADY_TERMINAL' ? 409 : 404;
    throw new ServerError(result.error || 'Cancel failed', { status, code: result.code || 'NOT_FOUND' });
  }
  res.json(result);
}));

// Params that point at multipart-staged temp files under PATHS.uploads. The
// gen modules unlink these on completion/failure, so a job that ran is no
// longer retryable from the persisted params alone (the files are gone, or
// — worse — could collide with a fresh upload at the same path).
const TEMP_UPLOAD_PARAMS = ['uploadedTempPath', 'uploadedTempPaths', 'audioFilePath'];
function hasTempUploadParam(params) {
  if (!params) return false;
  return TEMP_UPLOAD_PARAMS.some((k) => {
    const v = params[k];
    if (Array.isArray(v)) return v.length > 0;
    return typeof v === 'string' && v.length > 0;
  });
}

// Re-enqueue a terminal job. Optional `body.params` overrides specific
// user-facing fields (prompt, model, dimensions, etc.) so a user can edit
// a failed job's config in the UI before retrying without losing the rest
// of the original params. Non-listed params (interpreter paths, session ids)
// always inherit from the original job.
async function buildRetryJob(job, body) {
  if (!job) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  if (job.kind === 'video-upscale' && job.params?.mode === 'topaz') {
    throw new ServerError('Request a new Topaz estimate before starting another job. Check the original provider request if its outcome was uncertain.', { status: 409, code: 'TOPAZ_REQUOTE_REQUIRED' });
  }
  if (job.status === 'queued' || job.status === 'running') {
    throw new ServerError(
      `Job is still ${job.status} — cancel it before retrying`,
      { status: 409, code: 'JOB_NOT_TERMINAL' },
    );
  }
  if (isRemoteMediaJob(job) && job.params?.remotePeerReservation === true) {
    throw new ServerError(
      'This peer render has an uncertain outcome — reconcile the original job before retrying',
      { status: 409, code: 'JOB_REMOTE_OUTCOME_UNCERTAIN' },
    );
  }
  const rawOverrides = body.params ?? {};
  if (job.kind === 'video') assertReactorNegativePromptSupported(job.params?.mode, rawOverrides.negativePrompt);
  if (Object.hasOwn(rawOverrides, 'visualProfileSource')) throw new ServerError('A saved finish source cannot be supplied by a retry request', { status: 400, code: 'VALIDATION_ERROR' });
  if (Object.hasOwn(rawOverrides, 'visualProfile')) {
    const profile = validateRequest(universeVisualProfileSchema, rawOverrides.visualProfile);
    const next = normalizeUniverseVisualProfile(profile);
    const previous = normalizeUniverseVisualProfile(job.params?.visualProfile);
    if (JSON.stringify(next.generation) !== JSON.stringify(previous?.generation)) {
      throw new ServerError('Photography direction changed. Submit a new image generation request; this retry preserves the saved source.', { status: 409, code: 'VISUAL_PROFILE_GENERATION_CHANGED' });
    }
    rawOverrides.visualProfile = next;
  }
  // A `effort: 'default'` override is a clear-to-default signal, not a value to
  // merge — handled by deleting params.effort below so the render falls back to
  // the shipped CODEX_IMAGEGEN_DEFAULT_EFFORT. Exclude it from the merge set.
  const clearEffort = rawOverrides.effort === EFFORT_CLEAR_SENTINEL;
  // Strip undefined override values before merging — Zod's emptyToUndef
  // transform turns "" → undefined for model/modelId/effort, and a naive spread
  // would still set those keys to undefined on the merged params (clobbering
  // the original job's values). Filtering keeps unchanged fields intact.
  const overrides = Object.fromEntries(
    Object.entries(rawOverrides).filter(
      ([k, v]) => v !== undefined && !(k === 'effort' && clearEffort),
    ),
  );
  const params = { ...job.params, ...overrides };
  const characterLimit = 8000;
  const editedText = [
    ['Prompt', overrides.prompt],
    ['Negative prompt', overrides.negativePrompt],
    ...(overrides.chunkPrompts ?? []).map((text, index) => [`Segment ${index + 1} prompt`, text]),
  ];
  for (const [label, value] of editedText) {
    if (value?.length > characterLimit) {
      throw new ServerError(`${label} is ${value.length}/${characterLimit} characters. Shorten it to retry.`, { status: 400, code: 'VALIDATION_ERROR' });
    }
  }
  if (overrides.prompt !== undefined && !overrides.prompt.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if ((overrides.prompt !== undefined || overrides.negativePrompt !== undefined)
    && ['image', 'video'].includes(job.kind) && !isRemoteMediaJob(job)) {
    const parts = retryPromptParts(job.params ?? {});
    for (const [key, authoredKey] of [['prompt', 'authoredPrompt'], ['negativePrompt', 'authoredNegativePrompt']]) {
      if (overrides[key] === undefined) continue;
      const { prefix, suffix } = parts[key];
      const trailing = !overrides[key] && key === 'negativePrompt' ? suffix.replace(/^, /, '') : suffix;
      params[key] = `${prefix}${overrides[key]}${trailing}`;
      if (prefix || suffix || typeof params[authoredKey] === 'string') params[authoredKey] = overrides[key];
    }
  }

  if (job.kind === 'video' && params.mode === VIDEO_GEN_MODE.REACTOR && !isRemoteMediaJob(job)) {
    // Legacy retries can carry negatives that Reactor never received. Keep
    // the saved attempt untouched and record only what this retry sends.
    delete params.negativePrompt;
    delete params.authoredNegativePrompt;
    if (Array.isArray(params.promptAdditions)) {
      params.promptAdditions = params.promptAdditions.filter((item) => !isRetryNegativePromptAddition(item));
    }
  }

  if (params.visualProfile) params.visualProfileRevision = imageVisualProfileRevision(params.visualProfile);
  if (Object.entries(overrides).some(([key, value]) => key !== 'visualProfile' && JSON.stringify(value) !== JSON.stringify(job.params?.[key]))) delete params.visualProfileSource;
  const priorSegments = job.kind === 'video' && !isRemoteMediaJob(job)
    ? videoSegmentReplayReceiptSchema.safeParse({ parentJobId: job.id, segments: job.videoExecutions })
    : null;
  if (priorSegments && !priorSegments.success && job.videoExecutions != null
    && !(Array.isArray(job.videoExecutions) && job.videoExecutions.length === 0)) {
    throw new ServerError('Stored chain execution receipts are invalid; the original attempt has been preserved.', {
      status: 409, code: 'VIDEO_SEGMENT_RECEIPT_INVALID',
    });
  }
  if (priorSegments?.success) params.segmentReplayReceipt = priorSegments.data;
  if (job.kind === 'video') {
    const bounds = VIDEO_RETRY_BOUNDS_SCHEMA.safeParse(rawOverrides);
    if (!bounds.success) throw new ServerError('Video retry settings are outside the supported range', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (job.kind === 'image') {
    const bounds = IMAGE_RETRY_BOUNDS_SCHEMA.safeParse(rawOverrides);
    if (!bounds.success) throw new ServerError('Image retry size is outside the supported range', { status: 400, code: 'VALIDATION_ERROR' });
    if ((rawOverrides.width !== undefined || rawOverrides.height !== undefined) && !refineImagePixelCap(params)) {
      throw new ServerError(PIXEL_CAP_MESSAGE, { status: 400, code: 'VALIDATION_ERROR' });
    }
  }
  for (const key of ['seed', 'steps', 'guidanceScale', 'imageStrength', 'i2vReferenceMode', 'speedProfileId', 'draftDecode', 'streamingMode', 'a2vLoraStageStrengths']) {
    if (rawOverrides[key] === null) delete params[key];
  }
  if (job.kind === 'image' && !CLOUD_IMAGE_GEN_MODES.includes(params.mode) && !isRemoteMediaJob(job)) {
    const { getImageModels } = await import('../lib/mediaModels.js');
    const localInputs = params.reviewedReferenceRequest ? { ...params, ...params.reviewedReferenceRequest } : params;
    const modelId = localInputs.modelId === undefined ? LOCAL_IMAGEGEN_DEFAULT_MODEL : localInputs.modelId;
    assertLocalImageModelInputs(getImageModels().find(model => model.id === modelId), localInputs);
  }
  if (rawOverrides.chunks === 1) delete params.chunkPrompts;
  // Hosted video jobs (grok / fal / reactor) use `mode` as the cloud-dispatch
  // discriminator, not the local semantic mode prepareParams validates, and their
  // params carry provider fields (a fal model id, Reactor seconds) the local model
  // catalog cannot resolve. Each declared backend validates its own retry
  // (hostedSubmission.js); only local jobs reach the local validator.
  if (job.kind === 'video') {
    const validateHostedRetry = hostedVideoRetryValidator(params.mode);
    if (validateHostedRetry) validateHostedRetry(params);
    else {
      const { validateVideoRetryParams } = await import('../services/videoGen/prepareParams.js');
      const model = await validateVideoRetryParams(params);
      delete params.continuation;
      if (Number(params.chunks || 1) > 1 || params.continuityStrategy != null) {
        params.continuation = resolveContinuityRequest({ model,
          continuityStrategy: params.continuityStrategy, contextFrames: params.contextFrames });
      }
    }
  }
  // Reset Codex effort to the shipped default: dropping the key lets codex.js's
  // fallback (CODEX_IMAGEGEN_DEFAULT_EFFORT) take over, which a merged sentinel
  // string could not do (it would fail the CODEX_EFFORT_LEVELS validation).
  if (clearEffort) {
    if (params.effort !== undefined) delete params.visualProfileSource;
    delete params.effort;
  }
  // Reject retry when the original job referenced a multipart-staged upload —
  // the gen modules unlink those files on completion/failure, so re-enqueueing
  // would either fail with a missing-file error or, worse, act on a stale path
  // that's since been reused by a different upload.
  if (!params.visualProfileSource && hasTempUploadParam(job.params)) {
    throw new ServerError(
      'Job referenced an uploaded file that has since been cleaned up — re-submit the original request with the file attached instead of retrying',
      { status: 409, code: 'JOB_RETRY_TEMP_UPLOAD' },
    );
  }
  // enqueueJob re-normalizes any job carrying a `remoteMedia` marker, so a
  // merged prompt/model override (which never reached the peer anyway — the
  // remote executor renders from `remoteMedia.request`) cannot restore a
  // locally-renderable shape. What the retry DOES have to reset is the marker's
  // transient run state, which describes the finished attempt, not this one:
  //   - `cancelRequested` — inherited from a canceled render, it makes the
  //     executor's preflight abort the retry immediately, and the flag rides
  //     along again on every further retry. That render could never be re-run.
  //   - `reconcile` — "recover the provider job for this Idempotency-Key". The
  //     retry gets a fresh queue id, which IS the key, so there is nothing to
  //     recover; it must submit rather than skip preflight.
  // Cleared here, not in routedJobParams — boot restoration re-enqueues an
  // interrupted job under its ORIGINAL id and needs `reconcile: true` kept.
  // `?? {}` because the predicate gates on PRESENCE, not truthiness — a
  // hand-edited or peer-merged `remoteMedia: null` passes it, and this is the
  // one marker consumer that would hard-crash rather than fail closed in the
  // kind's remote module the way every other one does.
  if (isRemoteMediaJob({ kind: job.kind, params })) {
    const { cancelRequested: _canceled, reconcile: _reconcile, ...marker } = params.remoteMedia ?? {};
    params.remoteMedia = { ...marker, cancelRequested: false, reconcile: false };
  }
  return { kind: job.kind, params, owner: job.owner, keepArchived: priorSegments?.success === true };
}

router.post('/:id/retry/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(retryBodySchema, req.body ?? {});
  const { kind, params } = await buildRetryJob(getJob(req.params.id), body);
  const { previewRetryModelInput } = await import('../services/mediaJobRetryPreview.js');
  res.json(await previewRetryModelInput(kind, params));
}));

router.post('/:id/retry', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  const body = validateRequest(retryBodySchema, req.body ?? {});
  const { keepArchived, ...retry } = await buildRetryJob(job, body);
  const hasInputEdit = body.params?.prompt !== undefined || body.params?.negativePrompt !== undefined
    || body.params?.model !== undefined || body.params?.modelId !== undefined;
  const mode = retry.params.mode;
  const providerPromptCap = mode === IMAGE_GEN_MODE.RUNWAY
    || (retry.kind === 'video' && [VIDEO_GEN_MODE.FAL, VIDEO_GEN_MODE.HIGGSFIELD, VIDEO_GEN_MODE.REACTOR].includes(mode));
  const higgsfieldImage = retry.kind === 'image' && mode === IMAGE_GEN_MODE.HIGGSFIELD;
  if ((higgsfieldImage || (hasInputEdit && (providerPromptCap || retry.params.quickEdit))) && !isRemoteMediaJob(retry)) {
    const { previewRetryModelInput } = await import('../services/mediaJobRetryPreview.js');
    await previewRetryModelInput(retry.kind, retry.params);
  }
  const result = await enqueueJob(retry);
  // Prior chain attempts keep their only execution evidence under the existing
  // archive retention policy. The new job carries one snapshot, not a ledger.
  if (!keepArchived && !removeArchivedJob(job.id)) {
    console.log(`⚠️ media-job [${job.id.slice(0, 8)}] retry: archive prune found nothing to drop — old row may persist in /api/media-jobs`);
  }
  res.json({ ...result, retriedFrom: job.id });
}));

router.delete('/failed-canceled', asyncHandler(async (req, res) => {
  const { kind } = validateRequest(clearFailedCanceledSchema, req.query);
  res.json(await removeFailedCanceledJobs({ kind }));
}));

// Delete a terminal job from the failed/canceled archive. Live jobs
// (queued/running) are rejected — those need cancel first. Returns 404 for
// unknown ids so the UI can prune optimistically without worrying about a
// race with another tab pruning the same row.
router.delete('/:id', asyncHandler(async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  if (job.status === 'queued' || job.status === 'running') {
    throw new ServerError(
      `Job is still ${job.status} — cancel it before deleting`,
      { status: 409, code: 'JOB_NOT_TERMINAL' },
    );
  }
  if (isRemoteMediaJob(job) && job.params?.remotePeerReservation === true) {
    throw new ServerError(
      'This peer render has an uncertain outcome — reconcile the original job before deleting it',
      { status: 409, code: 'JOB_REMOTE_OUTCOME_UNCERTAIN' },
    );
  }
  if (job.result?.topazUncertain === true) throw new ServerError('Check the Topaz request before deleting this job.', { status: 409, code: 'TOPAZ_PENDING' });
  const removed = removeArchivedJob(req.params.id);
  if (!removed) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  res.json({ ok: true });
}));

// Promote a queued Codex job past the lane's parallel limit. GPU jobs are
// rejected — they serialize on the single MLX runtime.
router.post('/:id/run-now', asyncHandler(async (req, res) => {
  const result = runJobNow(req.params.id);
  if (!result.ok) {
    const status = result.code === 'NOT_FOUND' ? 404 : result.code === MEDIA_QUEUE_SHUTTING_DOWN ? 503 : 400;
    throw new ServerError(result.error || 'Run-now failed', { status, code: result.code });
  }
  res.json(result);
}));

// Bulk-cancel every queued job (running jobs are left alone — they need a
// per-id POST to trigger the SIGTERM path). Optional ?kind=image|video filter.
router.post('/cancel-queued', asyncHandler(async (req, res) => {
  const { kind } = validateRequest(cancelQueuedSchema, req.query);
  const result = await cancelQueuedJobs({ kind });
  res.json(result);
}));

export default router;
