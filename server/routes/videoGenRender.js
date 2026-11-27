/** Submit, monitor and cancel Video Gen renders and derived clips. */

import { assertCancelResult } from '../lib/cancelResponse.js';
import { sanitizeContinuation } from '../lib/videoContinuationProvenance.js';
import { Router } from 'express';
import { basename } from 'path';
import { randomUUID } from 'crypto';
import { resolveGalleryImage } from '../lib/fileUtils.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { optionalUploadFields } from '../lib/multipart.js';
import { validateRequest } from '../lib/validateRequest.js';
import { recordUserAction } from '../services/userActions.js';
import { enqueueStitch } from '../services/videoGen/stitchJob.js';
import { trimHistoryItem } from '../services/videoGen/trim.js';
import { handheldHistoryItem } from '../services/videoGen/handheld.js';
import { enqueueVertical } from '../services/videoGen/verticalJob.js';
import { extendHistoryClip } from '../services/videoGen/extendHosted.js';
import { cleanupMultipartTemp } from '../services/videoGen/prepareParams.js';
import { submitVideoGenJob } from '../services/videoGen/submitJob.js';
import { previewVideoPrompt } from '../services/videoGen/promptPreview.js';
import { REFERENCE_AUDIO_FIELDS, VIDEO_REFERENCE_IMAGE_FIELDS } from '../services/videoGen/requestFields.js';
import { attachSseClient, cancelJob, listJobs, laneConcurrencyFor } from '../services/mediaJobQueue/index.js';
import { mediaJobExecutionLane } from '../lib/generationModes.js';
import { getVideoModels } from '../lib/mediaModels.js';
import { icLoraSpecForMode } from '../lib/icLoraWeights.js';
import { effectiveJobPrompt } from '../lib/federatedMediaWire.js';
import { isRemoteMediaJob } from '../services/mediaJobQueue/remoteMediaJob.js';
import { getProject } from '../services/musicVideo/projects.js';
import { videoCancelBodySchema, videoExtendBodySchema } from '../lib/mediaGenerationValidation.js';
import { batchIdParamsSchema, generateBodySchema, handheldBodySchema, historyIdSchema, overnightBodySchema, overnightQuerySchema, promptPreviewBodySchema, stitchBodySchema, trimBodySchema, verticalBodySchema } from '../lib/videoGenValidation.js';

const router = Router();

// M4A files are stored in an MP4 container. Browsers and OS file pickers
// label them inconsistently: Safari uses `video/mp4`, Chrome/Firefox use
// `audio/mp4`, and some platforms emit `audio/x-m4a` or `audio/aac`.
// `audio/*` catches the obvious cases (WAV, MP3, OGG, FLAC…) but misses
// the MP4-container variants. The extension check is a defense-in-depth
// fallback so a `.m4a` always passes regardless of what the HTTP client
// decided to put in Content-Type.
export const isAudioMime = (mime, filename) => {
  if (!mime) return false;
  if (mime.startsWith('audio/')) return true;
  if (mime === 'video/mp4') {
    // Only allow video/mp4 when the extension confirms it's audio, not a
    // genuine video file drag-dropped onto the audio upload field.
    const ext = (filename || '').match(/\.([^.]+)$/)?.[1]?.toLowerCase();
    return ext === 'm4a' || ext === 'aac';
  }
  return false;
};

// FFLF accepts up to two image uploads (start and end frame); a2v takes one
// audio upload (audioFile); the IC-LoRA remix modes take one reference video
// upload (icReference); FastH3 Omni takes up to three voice clips in indexed
// slots (REFERENCE_AUDIO_FIELDS). Files stream to disk without a file-size cap.
// Per-fieldname mime filtering rejects mismatched parts
// up-front so a stray .mp4 drag-drop can't get staged under these fields.
const frameImageUpload = optionalUploadFields(['sourceImage', 'lastImage', 'audioFile', ...REFERENCE_AUDIO_FIELDS, ...VIDEO_REFERENCE_IMAGE_FIELDS, 'icReference', 'runwayVideo', 'runwayCharacterVideo'], {
  fileFilter: (_req, file, cb) => {
    const isImageField = file.fieldname === 'sourceImage' || file.fieldname === 'lastImage' || VIDEO_REFERENCE_IMAGE_FIELDS.includes(file.fieldname);
    const isAudioField = file.fieldname === 'audioFile' || REFERENCE_AUDIO_FIELDS.includes(file.fieldname);
    const isVideoField = ['icReference', 'runwayVideo', 'runwayCharacterVideo'].includes(file.fieldname);
    const okImage = isImageField && file.mimetype.startsWith('image/');
    const okAudio = isAudioField && isAudioMime(file.mimetype, file.originalname);
    // IC-LoRA references are clips — the control weight reads structure/motion
    // out of a depth/pose/edge video, so only video/* is meaningful here.
    const okVideo = isVideoField && file.mimetype.startsWith('video/');
    cb(null, okImage || okAudio || okVideo);
  },
});

// What Generate would send to the model, built by the render's own code (#11317).
router.post('/prompt-preview', optionalUploadFields([]), asyncHandler(async (req, res) => {
  res.json(await previewVideoPrompt(validateRequest(promptPreviewBodySchema, req.body ?? {})));
}));

router.post('/', frameImageUpload, asyncHandler(async (req, res) => {
  // The route owns cleanup before validation succeeds; the submit service owns
  // every failure after it receives parsed data.
  const uploads = req.files || {};
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    await cleanupMultipartTemp(uploads);
    failValidation(parsed);
  }
  const queued = await submitVideoGenJob(parsed.data, uploads);
  try {
    const happenedAt = new Date().toISOString();
    await recordUserAction({
      type: 'media.video.enqueue',
      actor: 'user',
      target: queued.jobId,
      summary: 'enqueued video job',
      payload: { jobId: queued.jobId },
      source: { route: `${req.baseUrl}${req.route?.path ?? ''}`, method: req.method },
      happenedAt,
      dedupeKey: `media.video.enqueue:${queued.jobId}`,
    });
  } catch (error) {
    console.error(`❌ Failed to record media.video.enqueue: ${error.message}`);
  }
  res.json(queued);
}));

// Overnight local clip batches (#15498): queue each shot × local reference model
// as its Shot card Render, held until `startAt`; anything still waiting at `stopBy` is dropped.
router.post('/overnight', asyncHandler(async (req, res) => {
  const { projectId, sceneIds, modelIds, startAt, stopBy } = validateRequest(overnightBodySchema, req.body ?? {});
  const [{ musicVideoClipReferences }, { overnightModelKind, overnightRenderBodies }] = await Promise.all([
    import('../services/musicVideo/clipCastReferences.js'), import('../services/musicVideo/overnightRenders.js'),
  ]);
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Music video not found', { status: 404, code: 'NOT_FOUND' });
  const catalog = getVideoModels();
  const models = modelIds.map((id) => catalog.find((model) => model.id === id));
  const unusable = modelIds.filter((id, i) => !overnightModelKind(models[i]));
  if (unusable.length) {
    throw new ServerError(`Overnight renders use LTX 2.5 or FastH3 Omni; ${unusable.join(', ')} takes no clip references.`, { status: 400, code: 'OVERNIGHT_MODEL_UNSUPPORTED' });
  }
  const batchId = randomUUID();
  const schedule = startAt || stopBy ? { ...(startAt ? { startAt } : {}), ...(stopBy ? { stopBy } : {}) } : undefined;
  const { bodies, skipped } = await overnightRenderBodies({ project, sceneIds: [...new Set(sceneIds)], models, schedule, batchId, clipReferences: musicVideoClipReferences });
  const queued = [];
  for (const { sceneId, modelId, body } of bodies) {
    const parsed = generateBodySchema.safeParse(body);
    if (!parsed.success) { skipped.push({ sceneId, modelId, reason: parsed.error.issues[0]?.message || 'Invalid request' }); continue; }
    try {
      const job = await submitVideoGenJob(parsed.data, {});
      queued.push({ sceneId, modelId, jobId: job.jobId });
    } catch (err) {
      skipped.push({ sceneId, modelId, reason: err.message });
    }
  }
  console.log(`🌙 Overnight batch ${batchId.slice(0, 8)}: ${queued.length} queued, ${skipped.length} skipped`);
  res.json({ batchId, queued, skipped });
}));

router.get('/overnight', asyncHandler(async (req, res) => {
  const { projectId } = validateRequest(overnightQuerySchema, req.query);
  const { overnightBatches } = await import('../services/musicVideo/overnightRenders.js');
  res.json({ batches: overnightBatches(listJobs({ kind: 'video' }), projectId) });
}));

// Cancel a batch's remaining jobs; a running render is stopped too, finished takes stay.
router.delete('/overnight/:batchId', asyncHandler(async (req, res) => {
  const { batchId } = validateRequest(batchIdParamsSchema, req.params);
  const live = listJobs({ kind: 'video' }).filter((job) => job.params?.musicVideo?.batchId === batchId
    && (job.status === 'queued' || job.status === 'running'));
  let canceled = 0;
  for (const job of live) {
    const result = await cancelJob(job.id);
    if (result?.ok) canceled += 1;
  }
  res.json({ canceled });
}));

// Currently-running video job (if any) so the page can re-attach after a
// reload — the SSE replay of `lastPayload` then resumes progress display.
// Mirrors GET /api/image-gen/active. Returns `{ activeJob: null }` when no
// video render is in flight. Queued-but-not-yet-running jobs are returned
// too so the user lands on a "Queued (position N)" state instead of an
// empty form. Selection order MUST match /cancel below: newest queued is
// what cancelVideoGen() targets when nothing is running, so resuming the
// oldest queued would leave the resumed page's Cancel button hitting a
// different job.
//
// Whitelist the params the UI form actually consumes — `job.params`
// carries server-internal absolute file paths (sourceImagePath,
// audioFilePath, uploadedTempPath(s), extendFromVideoPath) and the
// resolved pythonPath, none of which belong on a client surface.
const ACTIVE_JOB_PARAM_FIELDS = [
  'prompt', 'negativePrompt', 'modelId',
  'width', 'height', 'numFrames', 'fps',
  'steps', 'guidanceScale', 'seed',
  'tiling', 'disableAudio', 'displaySleep', 'mode', 'chunks', 'chunkPrompts', 'contextFrames', 'imageStrength',
  // Plain enum, no path — safe to echo so a reloading page restores the promise the
  // in-flight render is actually keeping.
  'i2vReferenceMode',
  // A registry id, not a path — safe to echo so a reloading page restores the
  // conditioner the in-flight render is actually using.
  'textEncoderId',
  // Likewise a registry id — the sampler schedule the in-flight render picked,
  // so a reloading page restores the picker instead of snapping back to Quality.
  'speedProfileId',
  // Block-streaming request (#6499) — a closed enum with no path, safe to
  // echo so a reloading page restores the picker instead of snapping back to
  // Auto.
  'streamingMode', 'a2vLoraStageStrengths',
  'audioStartSec',
  // Grok jobs (#2859 phase 2): the semantic t2v/i2v mode ('mode' holds the
  // 'grok' discriminator for them) and the clip duration — both plain
  // values, safe to echo for the reloading page's form restore.
  'videoMode', 'duration',
  'targetAspectRatio', 'ratio', 'bodyControl', 'expressionIntensity',
  // reactor.inc jobs (#6214): the clip to chain from, the clip length, and the
  // fast-h3 session canvas — all plain scalars (no filesystem path), safe to
  // echo for the reloading page's form restore. `seed` above already covers
  // reactor's seed field.
  'continueFromClipId', 'seconds', 'aspect',
  // loras are { filename, scale } basenames (no server filesystem paths), so
  // they're safe to echo back for the resuming picker to repopulate.
  'loras',
  // IC-LoRA remix dials — plain scalars, safe to echo. The reference clip
  // itself rides a separate basename mapping below (its param is an absolute
  // path, which the whitelist exists to keep off this surface).
  'icStrength', 'icAttentionStrength', 'icSkipStage2',
  // Plain scalars the local warm batch and hosted lanes persist; the client
  // restores them so a reload keeps the in-flight render's batch/size/audio.
  'batchSize', 'resolution', 'generateAudio',
];
const pickJobParams = (job) => {
  const params = job?.params;
  if (!params || typeof params !== 'object') return {};
  const out = {};
  for (const k of ACTIVE_JOB_PARAM_FIELDS) {
    if (params[k] !== undefined) out[k] = params[k];
  }
  if (['frame', 'window'].includes(params.continuityStrategy)) out.continuityStrategy = params.continuityStrategy;
  const continuation = sanitizeContinuation(params.continuation);
  if (continuation) out.continuation = continuation;
  // keyframes ride a separate mapping rather than the raw whitelist: they're
  // stored as { path, index } where `path` is an absolute gallery path (the
  // same internal-path-leak the whitelist exists to prevent — see the
  // comment above). Re-derive the gallery basename as `file` so the resuming
  // client's multi-keyframe picker can repopulate { file, index } entries
  // (its submit shape) without ever seeing the server's filesystem layout.
  if (Array.isArray(params.keyframes)) {
    const mapped = params.keyframes
      .filter((kf) => kf && typeof kf.path === 'string' && Number.isInteger(kf.index))
      .map((kf) => ({ file: basename(kf.path), index: kf.index }));
    if (mapped.length) out.keyframes = mapped;
  }
  // IC-LoRA references are absolute paths for the same reason keyframes are —
  // echo only the basename so the resuming form can show WHICH clip is in
  // flight without leaking the staging/data layout. The client can't re-submit
  // from a basename alone (an upload isn't re-derivable), so this is display
  // only; the resumed render is already queued with the real path.
  if (Array.isArray(params.icReferencePaths)) {
    const references = params.icReferencePaths
      .filter((p) => typeof p === 'string' && p)
      .map((path) => ({ path, name: basename(path) }));
    const names = references.map((ref) => ref.name);
    if (names.length) out.icReferenceNames = names;
    // A Music Video cast guide can live outside the gallery. Only restore the
    // whole set when every basename resolves to the SAME gallery path; a partial
    // restore could submit a different identity or silently omit one.
    if (names.length && icLoraSpecForMode(params.mode)?.referenceKind === 'image'
      && references.every(({ path, name }) => resolveGalleryImage(name, { mustExist: false }) === path)) {
      out.icReferenceImageFiles = names;
    }
  }
  if (params.mode === 'ic-ingredients-25' && typeof params.sourceImagePath === 'string' && params.sourceImagePath) {
    const name = basename(params.sourceImagePath);
    if (resolveGalleryImage(name, { mustExist: false }) === params.sourceImagePath) out.sourceImageFile = name;
    else out.unavailableSourceImageName = name;
  }
  // Same display-only echo as the IC references above: basenames only. They ARE
  // the gallery filenames, so the resuming form can repopulate its picker.
  if (Array.isArray(params.referenceAudioPaths) && params.referenceAudioPaths.length) {
    out.referenceAudioNames = params.referenceAudioPaths.filter((p) => typeof p === 'string' && p).map((p) => basename(p));
  }
  if (Array.isArray(params.referenceVideoPaths) && params.referenceVideoPaths.length) {
    out.referenceVideoNames = params.referenceVideoPaths.filter((p) => typeof p === 'string' && p).map((p) => basename(p));
  }
  if (Array.isArray(params.referenceImagePaths) && params.referenceImagePaths.length) {
    // Only gallery-backed paths can be submitted again by filename. Internal
    // cast guides may live in another image-input root with the same basename.
    const references = params.referenceImagePaths.filter((p) => typeof p === 'string' && p)
      .map((path) => ({ path, name: basename(path) }))
      .map(({ path, name }) => ({ name, gallery: resolveGalleryImage(name, { mustExist: false }) === path }));
    const files = references.filter((ref) => ref.gallery).map((ref) => ref.name);
    const unavailable = references.filter((ref) => !ref.gallery).map((ref) => ref.name);
    if (files.length) out.referenceImageFiles = files;
    if (unavailable.length) out.unavailableReferenceImageNames = unavailable;
  }
  // A federated render's prompt and model live only inside the versioned marker
  // — the top-level copies are blanked so a downgraded build fails closed
  // (#4683). Read through to the wire request, as the queue's own projection
  // does, or a page reload mid-render resumes the form with an empty prompt and
  // the LOCAL default model instead of the peer's.
  if (isRemoteMediaJob(job)) {
    const prompt = effectiveJobPrompt(job);
    if (typeof prompt === 'string') out.prompt = prompt;
    const { modelId } = params.remoteMedia.request ?? {};
    if (typeof modelId === 'string' && modelId) out.modelId = modelId;
  }
  return out;
};

router.get('/active', (_req, res) => {
  const runningList = listJobs({ kind: 'video', status: 'running' });
  const queuedList = runningList.length === 0 ? listJobs({ kind: 'video', status: 'queued' }) : [];
  const queued = queuedList.length ? queuedList[queuedList.length - 1] : null;
  const primaryJob = runningList[0] || queued;

  const formatJob = (job) => ({
    jobId: job.id,
    generationId: job.id,
    status: job.status,
    position: job.position,
    startedAt: job.startedAt || null,
    params: pickJobParams(job),
  });

  const activeJobs = runningList.map(formatJob);
  const activeJob = primaryJob ? formatJob(primaryJob) : null;
  const sampleJob = primaryJob || runningList[0];
  const lane = sampleJob ? mediaJobExecutionLane({ kind: sampleJob.kind, mode: sampleJob.params?.mode }) : 'gpu';
  const isLocal = lane === 'gpu';
  const limit = (typeof laneConcurrencyFor === 'function' && sampleJob) ? laneConcurrencyFor(sampleJob) : 1;

  if (!primaryJob && runningList.length === 0) {
    return res.json({ activeJob: null });
  }

  res.json({
    activeJob,
    activeJobs,
    limit,
    ...(isLocal ? { memoryGoverned: true, limitReason: 'memory-governed' } : {}),
  });
});

router.get('/:jobId/events', (req, res) => {
  const ok = attachSseClient(req.params.jobId, res);
  if (!ok) throw new ServerError('Job not found or expired', { status: 404 });
});

router.post('/cancel', asyncHandler(async (req, res) => {
  // Cancel selection rules, in priority order:
  //   1. Explicit body.jobId — cancel exactly that job (queued or running).
  //      Required for users with multiple in-flight renders.
  //   2. No jobId — cancel the currently-running video job (legacy behavior).
  //   3. No running job — cancel the newest queued video job so the user can
  //      take back a submission they regret while it's still in line.
  // A supplied-but-malformed jobId is a 400, not "absent": absent selects the
  // running job, which would cancel a different render than the one named (#9932).
  const { jobId: requestedJobId } = validateRequest(videoCancelBodySchema, req.body ?? {});
  if (requestedJobId) {
    // Validate that the jobId is a video job before cancelling, so a stray
    // image jobId from another tab doesn't accidentally cancel here.
    const job = listJobs({ kind: 'video' }).find((j) => j.id === requestedJobId);
    if (!job) throw new ServerError('Video job not found', { status: 404, code: 'NOT_FOUND' });
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new ServerError(`Job already ${job.status}`, { status: 409, code: 'ALREADY_TERMINAL' });
    }
    return res.json(assertCancelResult(await cancelJob(job.id)));
  }
  const running = listJobs({ kind: 'video', status: 'running' });
  if (running.length) return res.json(assertCancelResult(await cancelJob(running[0].id)));
  // No running render — cancel the newest queued video instead so the user
  // can pull back a submission before it starts.
  const queued = listJobs({ kind: 'video', status: 'queued' });
  const result = queued.length > 0 && await cancelJob(queued[queued.length - 1].id);
  res.json(assertCancelResult(result, { notFoundMessage: 'No active or queued video render' }));
}));

// Keep a frame range of a clip: `startSec` drops the frames before it, `endSec`
// the frames from it on. Like an upscale, it writes a NEW gallery row and
// leaves the source clip untouched.
router.post('/history/:id/trim', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(trimBodySchema, req.body ?? {});
  res.json({ ok: true, video: await trimHistoryItem(parsed.data, body) });
}));

// Re-shoot a clip as if handheld (lib/handheldCamera.js): zoomed in a little,
// with the margin swaying, rolling and bobbing with footsteps. Like a trim, it
// writes a NEW gallery row and leaves the source clip untouched.
router.post('/history/:id/handheld', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(handheldBodySchema, req.body ?? {});
  res.json({ ok: true, video: await handheldHistoryItem(parsed.data, body) });
}));

// "Make it vertical" (lib/verticalReframe.js): the clip centred over a blurred copy of itself on
// a 9:16, 4:5 or 1:1 canvas. Queued as a media job; a repeat request returns the live job.
router.post('/history/:id/vertical', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(verticalBodySchema, req.body ?? {});
  res.json({ ok: true, job: await enqueueVertical(parsed.data, body.ratio) });
}));

// Continue a hosted clip on its model's extend endpoint (#16150); `dryRun` returns the exact body and price.
router.post('/history/:id/extend', asyncHandler(async (req, res) => {
  const parsed = historyIdSchema.safeParse(req.params.id);
  if (!parsed.success) failValidation(parsed);
  const body = validateRequest(videoExtendBodySchema, req.body ?? {});
  res.json(await extendHistoryClip(parsed.data, body));
}));

router.post('/stitch', asyncHandler(async (req, res) => {
  const parsed = stitchBodySchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  // The concat runs as a media job (#13000); the row lands in history when it
  // finishes. A repeat POST of the same ordered ids returns the live job.
  res.json({ ok: true, job: await enqueueStitch(parsed.data.videoIds) });
}));

export default router;
