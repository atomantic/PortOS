/**
 * prepareVideoGenParams — pre-dispatch preparation for POST /video-gen.
 *
 * Mirrors `services/imageGen/prepareParams.js`: everything between Zod
 * validation and the final `enqueueJob` call lives here, so the route stays a
 * thin parse → prepare → enqueue → respond shell.
 *
 * Handles, in this exact order (several checks depend on an earlier one having
 * run — see the inline notes before reordering anything):
 *   - resolve the effective backend through the #3231 pin ladder
 *   - validate modelId + local-python configuration
 *   - a2v / IC-LoRA mode↔upload pairing and reference-count bounds
 *   - stage multipart uploads into PATHS.uploads with rollback bookkeeping
 *   - grok short-circuit (grok reads only prompt/dims/source image/duration)
 *   - keyframe resolution + range checks
 *   - render-history resolution for native extend and IC references
 *   - LoRA-array normalization and chunk-count resolution
 *
 * On failure it unlinks every durable copy staged so far plus every multipart
 * temp file, then throws `ServerError` so the route's asyncHandler middleware
 * translates it into a 4xx/5xx response.
 *
 * `body` is mutated in place for the one field the legacy handler defaulted
 * (`mode` → 'fflf' when keyframes are supplied without an explicit mode); the
 * resolved value is also returned as `mode` so callers never need to re-read it.
 */

import { existsSync } from 'fs';
import { copyFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, extname } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, resolveGalleryImage } from '../../lib/fileUtils.js';
import { probeVideoDuration, safeUnder } from '../../lib/ffmpeg.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import {
  videoLoraFamily,
  isMiniMaxH3Runtime,
  isLtx2FamilyRuntime,
  isAudioToVideoRuntime,
} from '../../lib/runners.js';
import {
  isStockTextEncoder, supportsVideoTextEncoder, videoTextEncoderUnsupportedError,
} from '../../lib/videoTextEncoders.js';
import { minimaxH3ControlError } from './minimaxH3Controls.js';
import { resolveContextFrames } from '../../lib/videoContinuity.js';
import {
  IC_LORA_MODE_VALUES, icLoraSpecForMode,
  assertIcReferenceCount, describeIcReferenceRange,
} from '../../lib/icLoraWeights.js';
import { getSettings } from '../settings.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getTrack } from '../tracks/index.js';
import { VIDEO_GEN_MODE, resolveVideoMode } from './modes.js';
import { isDefaultI2vReferenceMode } from '../../lib/videoReferenceModes.js';
import {
  listVideoModels,
  defaultVideoModelId,
  BYOV_VIDEO_RUNTIMES,
  loadHistory,
  DEFAULT_NUM_FRAMES,
} from './local.js';
import {
  captureSystemCapabilities,
  detectSystemCapabilities,
  isHardwareCompatible,
  withHardwareCompatibility,
} from '../../lib/systemCapabilities.js';
// Straight from the leaf, not through local.js: the suites that exercise this
// module mock local.js wholesale, and a mocked rule table would assert nothing.
import { videoModeContractError, videoChainUnsupportedError, videoReferenceModeError } from './modeContract.js';
import { resolveByovRuntimeLoraCapable, videoLoraUnsupportedError } from './runtimes.js';
import { audioDurationToFrames } from './audioDuration.js';

// Retries reuse persisted worker parameters instead of passing through the
// multipart preparation path. Keep the model/mode gates here so a model edit
// cannot delete the original history row before the replacement is renderable.
export async function validateVideoRetryParams(params = {}) {
  const needsCuda = (requirements) => requirements?.requiresNvidiaGpu
    || requirements?.minVramGb != null
    || requirements?.minCudaComputeCapability != null;
  let capabilities = captureSystemCapabilities();
  const modelWasOmitted = params.modelId === undefined || params.modelId === '';
  let modelId = modelWasOmitted ? defaultVideoModelId(capabilities) : params.modelId;
  const knownModels = listVideoModels();
  let model = knownModels.find((entry) => entry.id === modelId);
  if (needsCuda(model?.hardwareRequirements)) {
    capabilities = await detectSystemCapabilities();
    if (modelWasOmitted) modelId = defaultVideoModelId(capabilities);
    model = knownModels.find((entry) => entry.id === modelId);
  }
  model = model && withHardwareCompatibility(model, capabilities, model.hardwareRequirements);
  if (!model) {
    throw new ServerError(`Unknown modelId: ${modelId}`, { status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' });
  }
  if (!isHardwareCompatible(model.hardwareCompatibility)) {
    throw new ServerError(
      `Video model "${modelId}" is unavailable on this machine: ${model.hardwareCompatibility.reasons.join(' · ')}`,
      { status: 400, code: 'MODEL_HARDWARE_UNAVAILABLE' },
    );
  }
  if (!isStockTextEncoder(params.textEncoderId)
    && !supportsVideoTextEncoder(model, params.textEncoderId)) {
    throw videoTextEncoderUnsupportedError(model, params.textEncoderId);
  }
  const mode = params.mode || (params.sourceImagePath ? 'image' : 'text');
  const modeError = videoModeContractError({
    model,
    mode,
    hasFirstImage: Boolean(params.sourceImagePath),
    hasLastImage: Boolean(params.lastImagePath),
    keyframes: params.keyframes,
    extendFromVideo: params.extendFromVideoPath,
    audioFile: params.audioFilePath,
    icReferences: params.icReferencePaths,
  });
  if (modeError) throw modeError;
  // Reference-mode promise (#4874). A retry replays persisted params without
  // passing the route schema, so an entry written by a newer/edited install (or
  // a model swapped to a runtime that can't honor the mode) has to be caught
  // here rather than reaching the render as a silent downgrade to anchor.
  const referenceModeError = videoReferenceModeError({
    model,
    mode,
    referenceMode: params.i2vReferenceMode,
    hasFirstImage: Boolean(params.sourceImagePath),
  });
  if (referenceModeError) throw referenceModeError;
  if (Number(params.chunks || 1) > 1) {
    const chainError = videoChainUnsupportedError(model);
    if (chainError) throw chainError;
    if (Array.isArray(params.keyframes) && params.keyframes.length > 0) {
      throw new ServerError(
        'keyframes cannot be combined with chunks > 1 — keyframes anchor a single clip.',
        { status: 400, code: 'KEYFRAMES_CHUNKS_CONFLICT' },
      );
    }
    if (icLoraSpecForMode(mode) || (Array.isArray(params.icReferencePaths) && params.icReferencePaths.length > 0)) {
      throw new ServerError(
        'IC-LoRA modes cannot be combined with chunks > 1 — the reference clip anchors a single render.',
        { status: 400, code: 'IC_LORA_CHUNKS_CONFLICT' },
      );
    }
  }
  if ((mode === 'a2v' && !isAudioToVideoRuntime(model.runtime))
    || (icLoraSpecForMode(mode) && !isLtx2FamilyRuntime(model.runtime))) {
    throw new ServerError(
      mode === 'a2v'
        ? `a2v mode requires an audio-to-video runtime. Model "${modelId}" runs on "${model.runtime || 'mlx_video'}".`
        : `${mode} mode requires an ltx2-runtime model. Model "${modelId}" runs on "${model.runtime || 'mlx_video'}".`,
      { status: 400, code: mode === 'a2v' ? 'A2V_RUNTIME_UNSUPPORTED' : 'IC_LORA_REQUIRES_LTX2' },
    );
  }
  if (Array.isArray(params.loras) && params.loras.length > 0 && !videoLoraFamily(model)) {
    const runtimeLoraCapable = await resolveByovRuntimeLoraCapable(model.runtime);
    if (!videoLoraFamily({ ...model, runtimeLoraCapable })) {
      throw videoLoraUnsupportedError(model, modelId);
    }
  }
  const numFrames = params.numFrames ?? model.defaultFrames ?? DEFAULT_NUM_FRAMES;
  const fps = params.fps ?? 24;
  if (isMiniMaxH3Runtime(model.runtime)) {
    const controlError = minimaxH3ControlError({
      model,
      negativePrompt: params.negativePrompt,
      disableAudio: params.disableAudio,
      tiling: params.tiling,
      numFrames,
      fps,
    });
    if (controlError) throw controlError;
  }
  if (model.runtime === 'wan22' || model.runtime === 'wan22_cuda') {
    const frameStride = Number(model.frameStride);
    if (Number.isFinite(frameStride) && frameStride > 0 && (Number(numFrames) - 1) % frameStride !== 0) {
      throw new ServerError(
        `${model.name} requires a ${frameStride}n+1 frame count; got ${numFrames}.`,
        { status: 400, code: 'WAN22_INVALID_FRAME_COUNT' },
      );
    }
  }
}

/**
 * Best-effort unlink of every multipart temp file the parser wrote before the
 * handler ran. Exported because the route needs it on the Zod-parse failure
 * path, which happens before this service is ever called.
 *
 * @param {object} uploads - `req.files` keyed by fieldname (may be empty)
 */
export const cleanupMultipartTemp = async (uploads) => {
  for (const f of Object.values(uploads || {})) {
    if (f?.path) await unlink(f.path).catch(() => {});
  }
};

/**
 * Run `fn`, releasing everything staged so far if it throws or rejects, then
 * rethrow the original error unchanged (#3326).
 *
 * Per the repo's no-try/catch convention a rejected await bubbles straight to
 * the error middleware — skipping the explicit `cleanupStaged()` calls at each
 * throw site and orphaning every durable copy written so far (the job is never
 * enqueued, so the worker's cleanup never runs either). This wrapper is the
 * sanctioned exception for the same reason the `ensureDir` guard below is: the
 * cleanup is a resource-release obligation, not error handling. One guard
 * covers every rejection point at once and stays correct as new awaits appear.
 *
 * @param {() => Promise<any>|any} fn - work that may leave staged files behind
 * @param {() => Promise<void>} cleanupStaged - rollback hook (idempotent)
 */
export const withStagedRollback = async (cleanupStaged, fn) => {
  try {
    return await fn();
  } catch (err) {
    await cleanupStaged();
    throw err;
  }
};

/**
 * @param {object} opts
 * @param {object} opts.body    - validated + coerced body from Zod (mutated in place)
 * @param {object} opts.uploads - `req.files` from multer (may be empty)
 * @param {string[]} opts.localOnlyParamKeys - field names only the local runtimes
 *   consume; a request carrying any of them is not grok-deliverable. Passed in
 *   from the route (which owns their Zod schemas) so this module never has to
 *   import back into `routes/`.
 * @returns {Promise<object>} On the grok lane:
 *   `{ backend, grok, effectiveModel, sourceImagePath, uploadedTempPath,
 *   discardSourceImage, cleanupStaged }`.
 *   On the local lane, additionally `{ pythonPath, effectiveModelId, mode,
 *   lastImagePath, audioFilePath, icReferencePaths, resolvedKeyframes,
 *   extendFromVideoPath, uploadedTempPaths, loras, effectiveChunks,
 *   effectiveChunkPrompts }`.
 *   `cleanupStaged` is the caller's rollback hook for anything that can still
 *   throw after this resolves (today: `enqueueJob`) — pass it to
 *   `withStagedRollback`.
 */
export async function prepareVideoGenParams({ body, uploads, localOnlyParamKeys }) {
  const settings = await getSettings();
  // #3231 Phase 4 — the video pin ladder. An explicit `body.backend` always
  // wins (the VideoGen page and the MV director board both send one); when
  // absent, consult the music-video target pin (for director-board renders)
  // and the install-wide `settings.videoGen.mode` via resolveVideoMode. A pin
  // is honored only for a grok-DELIVERABLE request shape — the grok lane reads
  // only prompt/dims/source-image/duration, so a request carrying local-only
  // machinery (a semantic mode beyond text/image, keyframes, audio, IC refs,
  // extend, LoRAs, a last frame, chunked renders) stays local rather than
  // silently dropping those inputs. A pin degrades; only an explicit backend
  // request errors.
  const grokDeliverable = (!body.mode || body.mode === 'text' || body.mode === 'image')
    // A named local model is local-only machinery in the same sense as the
    // fields below — grok has no model knob, so honoring a grok pin here
    // would silently discard the model the caller asked for (e.g. a media
    // requeue rebuilding a local render's config without a backend field).
    && !body.modelId
    && !localOnlyParamKeys.some((param) => body[param] !== undefined)
    && !uploads.lastImage && !body.lastImageFile
    && !uploads.audioFile
    && !uploads.icReference && !body.icReferenceVideoIds?.length && !body.icReferenceImageFiles?.length
    && !body.extendFromVideoId
    && !body.keyframes?.length
    && !body.loraFilenames?.length
    && !(body.chunks != null && Number(body.chunks) > 1);
  const backend = body.backend
    || (grokDeliverable
      ? resolveVideoMode(null, settings, { target: body.musicVideo ? RENDER_TARGET.MUSIC_VIDEO : null })
      : VIDEO_GEN_MODE.LOCAL);
  // A loose reference (#4874) is a LOCAL-runtime capability. The model gate
  // further down asks whether the chosen model's runtime can honor it — but an
  // explicit `backend: 'grok'` never reaches that runtime at all: grok's
  // image_to_video always anchors, and its short-circuit below drops every
  // local-only knob. Rejecting here (before any staging) is what keeps
  // "Inspire" from quietly returning an anchored clip from the cloud lane.
  if (backend !== VIDEO_GEN_MODE.LOCAL && !isDefaultI2vReferenceMode(body.i2vReferenceMode)) {
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      `The ${backend} backend always anchors a reference image as frame one — switch to a local LTX-2.5 model, or use the Anchor reference mode.`,
      { status: 400, code: 'I2V_REFERENCE_MODE_UNSUPPORTED' },
    );
  }
  const pythonPath = settings.imageGen?.local?.pythonPath || null;
  // Resolve the effective model up front — both the modelId-exists check
  // below AND the a2v runtime guard further down need the model entry,
  // and listVideoModels() is the kind of thing test mocks easily get out
  // of sync if called twice.
  const knownModels = listVideoModels();
  const needsCuda = (requirements) => requirements?.requiresNvidiaGpu
    || requirements?.minVramGb != null
    || requirements?.minCudaComputeCapability != null;
  let capabilities = captureSystemCapabilities();
  // `undefined`/empty means the request omitted a model and may use the
  // configured default. Explicit null is the routed-job sentinel and must
  // remain unknown so a legacy local dispatcher cannot render a remote job
  // locally.
  const modelWasOmitted = body.modelId === undefined || body.modelId === '';
  let effectiveModelId = modelWasOmitted ? defaultVideoModelId(capabilities) : body.modelId;
  let effectiveModel = knownModels.find((m) => m.id === effectiveModelId);
  if (needsCuda(effectiveModel?.hardwareRequirements)) {
    capabilities = await detectSystemCapabilities();
    if (modelWasOmitted) {
      effectiveModelId = defaultVideoModelId(capabilities);
      effectiveModel = knownModels.find((m) => m.id === effectiveModelId);
    }
  }
  effectiveModel = effectiveModel && withHardwareCompatibility(
    effectiveModel,
    capabilities,
    effectiveModel.hardwareRequirements,
  );
  // Validate modelId before staging (when supplied). Without this the queue
  // would happily accept a typo'd modelId and fail asynchronously inside
  // the worker — leaving a persisted, doomed queue entry.
  if (body.modelId !== undefined && !effectiveModel) {
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      `Unknown modelId: ${body.modelId}`,
      { status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' },
    );
  }
  if (effectiveModel && !isHardwareCompatible(effectiveModel.hardwareCompatibility)) {
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      `Video model "${effectiveModelId}" is unavailable on this machine: ${effectiveModel.hardwareCompatibility.reasons.join(' · ')}`,
      { status: 400, code: 'MODEL_HARDWARE_UNAVAILABLE' },
    );
  }
  // Substituted prompt conditioner (#4081). A pure registry lookup with no
  // dependency on anything staged, so it belongs with the other pre-staging
  // model gates: the request that named the bad conditioner is the only place
  // that can report it, and rejecting later would first write durable copies of
  // every upload for a render that was never going to run.
  if (effectiveModel && !isStockTextEncoder(body.textEncoderId)
    && !supportsVideoTextEncoder(effectiveModel, body.textEncoderId)) {
    await cleanupMultipartTemp(uploads);
    throw videoTextEncoderUnsupportedError(effectiveModel, body.textEncoderId);
  }
  // Reject up-front when the local python isn't configured AND the model's
  // runtime needs it. BYOV runtimes bring their own venv (resolved inside
  // buildArgs), so they must NOT be blocked by the legacy mlx_video
  // pythonPath setting. Without this gate, the queue would happily accept
  // a job that's known to fail and only surface it asynchronously on SSE,
  // polluting the persisted queue with a doomed entry. The allowlist is
  // shared with services/videoGen/local.js so the route and worker stay
  // in sync.
  const runtimeBringsOwnVenv = effectiveModel && BYOV_VIDEO_RUNTIMES.has(effectiveModel.runtime);
  if (!pythonPath && !runtimeBringsOwnVenv && backend !== 'grok') {
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      'Local video generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' },
    );
  }

  // Track every durable file we've already copied into PATHS.uploads so a
  // *later* staging failure can roll them back. Without this, staging
  // sourceImage successfully then failing on lastImage would leave the
  // sourceImage durable copy orphaned (the job is never enqueued, so the
  // worker's cleanup never runs).
  const stagedDurablePaths = [];
  const cleanupStaged = async () => {
    for (const p of stagedDurablePaths) await unlink(p).catch(() => {});
    await cleanupMultipartTemp(uploads);
  };

  // #3326 — every *explicit* throw below already calls cleanupStaged(), but a
  // plain rejected await (getMusicVideoProject / getTrack / loadHistory) would
  // bubble straight past them and orphan up to the full multipart size cap
  // under data/uploads. One guard around the whole staging region covers every
  // rejection point at once, and stays correct as new awaits are added.
  return withStagedRollback(cleanupStaged, () => resolvePreparedParams({
    body, uploads, settings, backend, pythonPath,
    effectiveModel, effectiveModelId, stagedDurablePaths, cleanupStaged,
  }));
}

/**
 * The staging + resolution region, split out so `prepareVideoGenParams` can
 * wrap it in a single rollback guard (#3326) without indenting 400 lines.
 * Every explicit throw here still calls `cleanupStaged()` itself so the
 * unwind order stays identical to the pre-extraction handler; `unlink` is
 * best-effort and idempotent, so the outer guard's second call is harmless.
 */
async function resolvePreparedParams({
  body, uploads, settings, backend, pythonPath,
  effectiveModel, effectiveModelId, stagedDurablePaths, cleanupStaged,
}) {
  // Stage a multipart upload into data/uploads so the queue worker can find
  // it after a server restart — the OS temp dir gets reaped on reboot, and a
  // persisted `queued` job may replay long after the original POST. Worker
  // unlinks the durable file when the job completes or cancels. Throws
  // ServerError on copy failure (and cleans up every staged file + multipart
  // temp upload so a mid-flight failure doesn't leak under /tmp + data/uploads).
  const stageUploadDurable = async (file, kind) => {
    const ext = extname(file.originalname || file.path) || '.bin';
    const durablePath = join(PATHS.uploads, `video-${kind}-${randomUUID()}${ext}`);
    try {
      await copyFile(file.path, durablePath);
    } catch (err) {
      await unlink(durablePath).catch(() => {});
      await cleanupStaged();
      throw new ServerError(
        `Failed to stage upload to durable location: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_UPLOAD_STAGE_FAILED' },
      );
    }
    await unlink(file.path).catch(() => {});
    stagedDurablePaths.push(durablePath);
    return durablePath;
  };

  // Music-video a2v jobs reuse an existing library track rather than uploading
  // the same song for every cut. Copy it into the queue-owned uploads area so
  // the worker may safely delete its input on completion without ever touching
  // the source track under data/music.
  const stageExistingAudioDurable = async (sourcePath) => {
    const ext = extname(sourcePath) || '.bin';
    const durablePath = join(PATHS.uploads, `video-audio-${randomUUID()}${ext}`);
    await copyFile(sourcePath, durablePath).catch(async (err) => {
      await unlink(durablePath).catch(() => {});
      await cleanupStaged();
      throw new ServerError(
        `Failed to stage project audio: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_AUDIO_STAGE_FAILED' },
      );
    });
    stagedDurablePaths.push(durablePath);
    return durablePath;
  };

  // Resolution precedence on each frame side: a fresh upload always wins over
  // a gallery filename so users can override a stale gallery pick by dropping
  // in a new file without first clearing the picker.
  //
  // Cleanup plumbing: `uploadedTempPath` (single, legacy) is RESERVED for the
  // start-frame upload — that field shape is what already-persisted jobs from
  // before this route change carry, so keeping its semantics stable means
  // those replays still clean up correctly. Every additional upload (today:
  // just `lastImage`) flows through `uploadedTempPaths` as an array. The
  // worker walks both fields when unlinking on terminal events.
  // Mode/upload pairing checks BEFORE staging so a rejected request only
  // unlinks the OS temp file (cheap) instead of also unlinking a freshly-
  // copied 100MB durable file under data/uploads (wasted disk I/O on every
  // bad request).
  if (body.mode === 'a2v' && !uploads.audioFile && !body.musicVideo) {
    await cleanupStaged();
    throw new ServerError(
      'a2v mode requires an audioFile upload or a music-video project audio source.',
      { status: 400, code: 'VIDEO_GEN_AUDIO_REQUIRED' },
    );
  }
  if (uploads.audioFile && body.mode !== 'a2v') {
    await cleanupStaged();
    throw new ServerError(
      `audioFile upload is only valid with mode='a2v' (got mode='${body.mode || 'unset'}').`,
      { status: 400, code: 'VIDEO_GEN_AUDIO_MODE_MISMATCH' },
    );
  }
  // IC-LoRA remix (mode='ic-control', …). Mirrors the a2v pairing checks: the
  // reference channel is what makes the mode meaningful, and an IC upload
  // outside an IC mode would be silently dropped by the worker.
  const icSpec = icLoraSpecForMode(body.mode);
  if (icSpec) {
    // The grok backend short-circuits below this point (it only reads
    // prompt/dims/source-image), so an IC request routed there would enqueue a
    // plain grok render with the reference clip silently dropped. The client's
    // mode bar snaps grok back to text/image, but reject explicitly so a direct
    // caller gets an error instead of a wrong-looking clip.
    if (body.backend === 'grok') {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode runs on the local ltx2 runtime — it isn't available on the Grok backend.`,
        { status: 400, code: 'IC_LORA_REQUIRES_LOCAL_BACKEND' },
      );
    }
    // Each weight takes exactly ONE kind of reference. An image-kind weight fed a
    // clip (or vice versa) doesn't error inside the pipeline — it produces
    // plausible-looking garbage — so reject the cross-kind fields explicitly
    // rather than silently dropping them.
    const wantsImages = icSpec.referenceKind === 'image';
    const videoShapePresent = !!uploads.icReference || !!body.icReferenceVideoIds?.length;
    if (wantsImages && videoShapePresent) {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode conditions on still images — pass gallery filenames as icReferenceImageFiles, not icReference / icReferenceVideoIds.`,
        { status: 400, code: 'IC_LORA_REFERENCE_KIND_MISMATCH' },
      );
    }
    if (!wantsImages && body.icReferenceImageFiles?.length) {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode conditions on a reference clip — pass icReference / icReferenceVideoIds, not icReferenceImageFiles.`,
        { status: 400, code: 'IC_LORA_REFERENCE_KIND_MISMATCH' },
      );
    }
    // The upload wins over gallery picks, so a request carrying both would
    // silently drop the picks. Force one shape per request instead. Checked
    // BEFORE the count bounds below, which would otherwise report a misleading
    // "needs exactly 1, got 2" for what is really a mixed-shape request.
    if (uploads.icReference && body.icReferenceVideoIds?.length) {
      await cleanupStaged();
      throw new ServerError(
        'icReference upload cannot be combined with icReferenceVideoIds — pass one reference shape per request.',
        { status: 400, code: 'IC_LORA_REFERENCE_CONFLICT' },
      );
    }
    // Reference count is the weight's contract, asserted once here against the
    // registry that owns the bounds. Checked before staging so a bad request only
    // unlinks the cheap OS temp file, and resolution below can't change the
    // count: an upload is exactly 1, every history id resolves 1:1 or throws, and
    // every gallery filename resolves 1:1 or throws.
    const refCount = wantsImages
      ? (body.icReferenceImageFiles?.length || 0)
      : (uploads.icReference ? 1 : 0) + (body.icReferenceVideoIds?.length || 0);
    if (refCount === 0) {
      // Special-cased ahead of the bounds assertion purely for actionability —
      // "needs exactly 1; got 0" doesn't tell the caller HOW to supply one.
      await cleanupStaged();
      throw new ServerError(
        wantsImages
          ? `${icSpec.label} mode requires ${describeIcReferenceRange(icSpec)} reference images — pick them from your gallery (icReferenceImageFiles).`
          : `${icSpec.label} mode requires a reference ${icSpec.referenceKind} — upload one (multipart field: icReference) or pick a prior render (icReferenceVideoIds).`,
        { status: 400, code: 'IC_LORA_REFERENCE_REQUIRED' },
      );
    }
    if (refCount < icSpec.minReferences || refCount > icSpec.maxReferences) {
      await cleanupStaged();
      assertIcReferenceCount(icSpec, refCount, (msg) => new ServerError(msg, {
        status: 400, code: 'IC_LORA_REFERENCE_COUNT',
      }));
    }
    // IC-LoRA remix is an LTX-2 primitive (ICLoraPipeline). Fail before enqueue
    // so a bad modelId can't pollute the persisted queue with a doomed job.
    if (effectiveModel && !isLtx2FamilyRuntime(effectiveModel.runtime)) {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode requires an ltx2-runtime model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
        { status: 400, code: 'IC_LORA_REQUIRES_LTX2' },
      );
    }
    // Chained renders re-seed each chunk from the previous chunk's last frame;
    // an IC render is conditioned on a whole reference clip instead, so there's
    // no defined semantic for chunk 2+ and it would silently ignore the mode.
    if (body.chunks != null && Number(body.chunks) > 1) {
      await cleanupStaged();
      throw new ServerError(
        `${icSpec.label} mode cannot be combined with chunks > 1 — the reference clip anchors a single render.`,
        { status: 400, code: 'IC_LORA_CHUNKS_CONFLICT' },
      );
    }
  } else if (uploads.icReference || body.icReferenceVideoIds?.length || body.icReferenceImageFiles?.length) {
    await cleanupStaged();
    throw new ServerError(
      `IC-LoRA reference inputs are only valid with an IC remix mode (${IC_LORA_MODE_VALUES.join(', ')}); got mode='${body.mode || 'unset'}'.`,
      { status: 400, code: 'IC_LORA_MODE_MISMATCH' },
    );
  }
  // a2v needs a runtime with an audio-conditioning path. The worker also
  // catches this in buildArgs, but checking here keeps the route's "fail fast
  // before enqueue" contract so a bad modelId can't pollute the persisted
  // queue with a doomed entry.
  if (body.mode === 'a2v' && effectiveModel && !isAudioToVideoRuntime(effectiveModel.runtime)) {
    await cleanupStaged();
    throw new ServerError(
      `a2v mode requires an audio-to-video runtime. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
      { status: 400, code: 'A2V_RUNTIME_UNSUPPORTED' },
    );
  }
  // Chunk chaining needs image-to-video on any runtime — the same rule
  // generateChainedVideo enforces at dispatch, applied once here so a doomed
  // chain never reaches the persisted queue.
  if (body.chunks != null && Number(body.chunks) > 1) {
    const chainError = videoChainUnsupportedError(effectiveModel);
    if (chainError) {
      await cleanupStaged();
      throw chainError;
    }
  }
  // Mode ↔ source pairing for every gated runtime, resolved through the one
  // contract the render boundary also throws from (#3736), so the two entry
  // points can't disagree about which shapes are legal or which code they
  // return. Runs before durable upload staging, keeping rejection cleanup cheap.
  const hasDeclaredFirstImage = Boolean(uploads.sourceImage || body.sourceImageFile);
  const hasDeclaredLastImage = Boolean(uploads.lastImage || body.lastImageFile);
  // Pinned here rather than re-derived at the resolved pass below: once a
  // declared gallery pick fails to resolve, "was this an i2v request?" can only
  // be answered from what the caller declared.
  const declaredMode = body.mode || (hasDeclaredFirstImage ? 'image' : 'text');
  const modeContractError = videoModeContractError({
    model: effectiveModel,
    mode: declaredMode,
    hasFirstImage: hasDeclaredFirstImage,
    hasLastImage: hasDeclaredLastImage,
    keyframes: body.keyframes,
    extendFromVideo: body.extendFromVideoId,
    audioFile: uploads.audioFile || body.musicVideo,
  });
  if (modeContractError) {
    await cleanupStaged();
    throw modeContractError;
  }
  // What the conditioning image PROMISES (#4874) — the orthogonal axis to the
  // mode/source pairing above, and the same "reject rather than silently deliver
  // something else" rule. Runs on the DECLARED shape for the same reason the
  // mode contract does: rejecting before durable staging keeps cleanup cheap, and
  // the resolved pass below re-checks once a gallery pick has become a real path.
  const declaredReferenceModeError = videoReferenceModeError({
    model: effectiveModel,
    mode: declaredMode,
    referenceMode: body.i2vReferenceMode,
    hasFirstImage: hasDeclaredFirstImage,
  });
  if (declaredReferenceModeError) {
    await cleanupStaged();
    throw declaredReferenceModeError;
  }
  // MiniMax H3 is fixed-24fps, joint A/V and CFG-distilled on both its runtimes
  // (MLX and CUDA). These are the model's non-mode controls; the mode gate
  // above already ran. Fail before queue persistence so a direct API caller
  // cannot enqueue a request whose controls the runtime would silently ignore —
  // the render boundary re-checks with the same helper.
  if (isMiniMaxH3Runtime(effectiveModel?.runtime)) {
    const controlError = minimaxH3ControlError({
      model: effectiveModel,
      negativePrompt: body.negativePrompt,
      disableAudio: body.disableAudio,
      tiling: body.tiling,
      numFrames: body.numFrames ?? effectiveModel.defaultFrames,
      fps: body.fps ?? 24,
    });
    if (controlError) {
      await cleanupStaged();
      throw controlError;
    }
  }
  // Wan profiles have a narrower temporal-shape contract than the shared
  // request schema can express (the mode side is the shared gate above). Mirror
  // the worker's frame-grid guard here so a direct API caller cannot persist a
  // job that is already known to fail.
  if (effectiveModel?.runtime === 'wan22' || effectiveModel?.runtime === 'wan22_cuda') {
    const numFrames = body.numFrames != null ? Number(body.numFrames) : DEFAULT_NUM_FRAMES;
    const frameStride = Number(effectiveModel.frameStride);
    if (Number.isFinite(frameStride) && frameStride > 0 && (numFrames - 1) % frameStride !== 0) {
      await cleanupStaged();
      throw new ServerError(
        `${effectiveModel.name} requires a ${frameStride}n+1 frame count; got ${numFrames}.`,
        { status: 400, code: 'WAN22_INVALID_FRAME_COUNT' },
      );
    }
  }

  let sourceImagePath = null;
  let lastImagePath = null;
  let audioFilePath = null;
  let effectiveNumFrames = body.numFrames;
  let icReferenceUploadPath = null;
  let uploadedTempPath = null;
  const extraUploadedTempPaths = [];
  if (uploads.sourceImage || uploads.lastImage || uploads.audioFile || uploads.icReference) {
    // Ensure the durable uploads dir exists before staging. Wrapped in
    // try/catch so a permission/disk failure here still cleans up the
    // multipart temp uploads instead of leaking them in the OS temp dir.
    try {
      await ensureDir(PATHS.uploads);
    } catch (err) {
      await cleanupStaged();
      throw new ServerError(
        `Failed to prepare uploads directory: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_UPLOADS_DIR_FAILED' },
      );
    }
  }
  if (uploads.sourceImage) {
    sourceImagePath = await stageUploadDurable(uploads.sourceImage, 'source');
    uploadedTempPath = sourceImagePath;
  } else if (body.sourceImageFile) {
    sourceImagePath = resolveGalleryImage(body.sourceImageFile);
  }
  // Re-run the same contract now that the gallery pick has been resolved to a
  // real path: the pre-staging pass only saw that a filename was *declared*, so
  // a stale/missing gallery entry would otherwise fall through to a text render.
  const resolvedModeError = videoModeContractError({
    model: effectiveModel,
    mode: declaredMode,
    hasFirstImage: Boolean(sourceImagePath),
    hasLastImage: hasDeclaredLastImage,
    sourceResolved: true,
    audioFile: uploads.audioFile || body.musicVideo,
    keyframes: body.keyframes,
    extendFromVideo: body.extendFromVideoId,
  });
  if (resolvedModeError) {
    await cleanupStaged();
    throw resolvedModeError;
  }
  // Same re-check for the reference-mode promise: a declared gallery pick that
  // failed to resolve leaves an i2v request with no image, and "Inspire" over
  // nothing is not a promise anything can keep.
  const resolvedReferenceModeError = videoReferenceModeError({
    model: effectiveModel,
    mode: declaredMode,
    referenceMode: body.i2vReferenceMode,
    hasFirstImage: Boolean(sourceImagePath),
  });
  if (resolvedReferenceModeError) {
    await cleanupStaged();
    throw resolvedReferenceModeError;
  }
  // Music Video director-board renders are always i2v FROM the scene's reference
  // frame (#1760 Phase 1). resolveGalleryImage returns null for a missing/invalid
  // gallery file (mustExist defaults true), and an unresolved source would
  // otherwise fall through to a text-to-video render — silently attaching a clip
  // that ignores the frame the director chose. Reject instead, so a stale/deleted
  // reference frame surfaces as a clear error rather than a wrong-looking clip.
  if (body.musicVideo && !sourceImagePath) {
    await cleanupStaged();
    throw new ServerError(
      'Music Video scene render needs a resolvable reference frame (sourceImageFile) — the scene\'s frame is missing or could not be resolved.',
      { status: 400, code: 'MUSIC_VIDEO_SOURCE_REQUIRED' },
    );
  }
  const discardSourceImage = async () => {
    if (uploadedTempPath) {
      await unlink(uploadedTempPath).catch(() => {});
      const index = stagedDurablePaths.indexOf(uploadedTempPath);
      if (index >= 0) stagedDurablePaths.splice(index, 1);
    }
    if (uploads.sourceImage?.path) await unlink(uploads.sourceImage.path).catch(() => {});
  };
  // Grok backend short-circuit (#2859 phase 2): everything past this point —
  // last-frame/keyframe staging, extend resolution, LoRA gating — is
  // local-runtime machinery grok doesn't use. sourceImagePath (upload or
  // gallery pick) is already resolved above, so an i2v render animates that
  // frame and a plain prompt runs the image-first image_gen → image_to_video
  // flow inside the provider. `backend` (not `body.backend`) so the #3231
  // pin ladder routes an unpinned-request grok default through here too.
  if (backend === 'grok') {
    const grok = settings.imageGen?.grok || {};
    if (!grok.enabled) {
      await cleanupStaged();
      throw new ServerError(
        'Grok Imagegen is disabled — enable it in Settings → Image Gen first',
        { status: 400, code: 'GROK_IMAGEGEN_DISABLED' },
      );
    }
    return {
      backend,
      grok,
      effectiveModel: { id: 'grok', supportedModes: ['text', 'image'] },
      sourceImagePath,
      uploadedTempPath,
      discardSourceImage,
      cleanupStaged,
    };
  }

  if (uploads.lastImage) {
    lastImagePath = await stageUploadDurable(uploads.lastImage, 'last');
    extraUploadedTempPaths.push(lastImagePath);
  } else if (body.lastImageFile) {
    // Same path-traversal guard as the start frame.
    lastImagePath = resolveGalleryImage(body.lastImageFile);
  }
  if (uploads.audioFile) {
    // a2v: audio file rides through the same durable-staging path as the
    // image uploads. Cleanup tracking via extraUploadedTempPaths so the
    // worker drops it on terminal events the same way it drops lastImage.
    audioFilePath = await stageUploadDurable(uploads.audioFile, 'audio');
    extraUploadedTempPaths.push(audioFilePath);
  } else if (body.mode === 'a2v' && body.musicVideo) {
    const project = await getMusicVideoProject(body.musicVideo.projectId);
    const sceneExists = project?.scenes?.some((scene) => scene.sceneId === body.musicVideo.sceneId);
    if (!project || !sceneExists) {
      await cleanupStaged();
      throw new ServerError('Music-video project or scene not found', { status: 404, code: 'NOT_FOUND' });
    }
    const track = project.trackId ? await getTrack(project.trackId) : null;
    const filename = track?.audioFilename || project.uploadedAudioFilename;
    const sourceAudioPath = filename ? safeUnder(PATHS.music, filename) : null;
    if (!sourceAudioPath || !existsSync(sourceAudioPath)) {
      await cleanupStaged();
      throw new ServerError('Music-video project audio is unavailable', { status: 400, code: 'VIDEO_GEN_PROJECT_AUDIO_MISSING' });
    }
    audioFilePath = await stageExistingAudioDurable(sourceAudioPath);
    extraUploadedTempPaths.push(audioFilePath);
  }
  // A direct-upload LTX-2.5 A2V request follows the whole audio file. The MLX
  // pipeline still requires an explicit 8n+1 frame canvas, so derive that canvas
  // from the durable upload rather than trusting browser metadata (or forcing an
  // API caller to probe the file itself). MiniMax Ref2VA is deliberately excluded:
  // its wrapper windows arbitrary-length audio and owns its duration internally.
  // Music-video jobs also keep their explicit scene canvas because they select a
  // slice of a longer song with audioStartSec.
  if (body.mode === 'a2v' && audioFilePath
    && effectiveModel?.audioDurationDriven === true
    && effectiveModel?.arbitraryLengthAudio !== true
    && !body.musicVideo) {
    const durationSeconds = await probeVideoDuration(audioFilePath);
    if (durationSeconds == null) {
      await cleanupStaged();
      throw new ServerError(
        'Could not read the uploaded audio duration. Upload a valid WAV, MP3, M4A, AAC, FLAC, or OGG file.',
        { status: 400, code: 'VIDEO_GEN_AUDIO_DURATION_UNREADABLE' },
      );
    }
    const frameStride = Number(effectiveModel.frameStride);
    const fps = Number(body.fps ?? 24);
    const maxNumFrames = Number(effectiveModel.maxNumFrames);
    if (!Number.isInteger(frameStride) || frameStride <= 0
      || !Number.isInteger(maxNumFrames) || maxNumFrames <= 0) {
      await cleanupStaged();
      throw new ServerError(
        `${effectiveModel.name} is missing its duration-driven frameStride/maxNumFrames contract.`,
        { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
      );
    }
    effectiveNumFrames = audioDurationToFrames(durationSeconds, fps, frameStride);
    if (effectiveNumFrames > maxNumFrames) {
      await cleanupStaged();
      throw new ServerError(
        `${effectiveModel.name} supports up to ${(maxNumFrames / fps).toFixed(1)}s in one audio-to-video render; this file is ${durationSeconds.toFixed(1)}s. Use MiniMax H3 Ref2VA for longer audio, or trim the file.`,
        { status: 400, code: 'VIDEO_GEN_AUDIO_TOO_LONG' },
      );
    }
  }
  if (uploads.icReference) {
    // IC-LoRA reference clip — same durable staging + cleanup tracking as the
    // audio upload above. A history-picked reference needs neither (it already
    // lives under data/videos/ and must survive the render).
    icReferenceUploadPath = await stageUploadDurable(uploads.icReference, 'ic-ref');
    extraUploadedTempPaths.push(icReferenceUploadPath);
  }

  // Multi-keyframe interpolation: resolve each gallery filename to an
  // absolute path under PATHS.images via the same path-traversal guard as
  // sourceImageFile. Reject up-front when any reference can't be resolved
  // so the queue doesn't accept a doomed job. Only valid for fflf mode +
  // single-chunk renders (the chain orchestrator pins keyframes only on
  // chunk 0; chaining ≥2 chunks with N keyframes has no defined semantic).
  let resolvedKeyframes = null;
  if (body.keyframes && body.keyframes.length >= 2) {
    if (body.mode && body.mode !== 'fflf') {
      await cleanupStaged();
      throw new ServerError(
        `keyframes is only valid with mode='fflf' (got mode='${body.mode}').`,
        { status: 400, code: 'KEYFRAMES_MODE_MISMATCH' },
      );
    }
    // Reject mixing keyframes with the legacy 2-keyframe inputs — the
    // worker would silently ignore sourceImage/lastImage when keyframes is
    // present, but staging/resizing them anyway is wasted work and the
    // ambiguity (which one wins?) bites callers later. Force the user to
    // pick one shape per request. Covers both upload paths and the
    // gallery-resolved file fields.
    if (sourceImagePath || lastImagePath || body.sourceImageFile || body.lastImageFile) {
      await cleanupStaged();
      throw new ServerError(
        'keyframes cannot be combined with sourceImage / lastImage inputs — pass each anchor frame as a keyframes[] entry instead.',
        { status: 400, code: 'KEYFRAMES_LEGACY_INPUTS_CONFLICT' },
      );
    }
    // Multi-keyframe FFLF is an LTX-2 primitive — the legacy mlx_video
    // pipeline has no equivalent. Mirror the a2v guard above so a bad
    // modelId can't enqueue a doomed job that will only fail in the
    // worker (with KEYFRAMES_REQUIRE_LTX2).
    if (effectiveModel && !isLtx2FamilyRuntime(effectiveModel.runtime)) {
      await cleanupStaged();
      throw new ServerError(
        `keyframes mode requires an ltx2-runtime model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
        { status: 400, code: 'KEYFRAMES_REQUIRE_LTX2' },
      );
    }
    // Default mode to 'fflf' when keyframes is set without an explicit mode —
    // otherwise local.js#buildLtx2Args resolves helperMode to 'text' and the
    // keyframes silently disappear.
    if (!body.mode) body.mode = 'fflf';
    if (body.chunks != null && Number(body.chunks) > 1) {
      await cleanupStaged();
      throw new ServerError(
        'keyframes cannot be combined with chunks > 1 — keyframes anchor a single clip.',
        { status: 400, code: 'KEYFRAMES_CHUNKS_CONFLICT' },
      );
    }
    // Validate keyframe indices against the *effective* numFrames so a
    // request with no explicit `numFrames` (which falls back to the
    // generateVideo default of 121) still rejects out-of-range indices
    // up-front instead of failing late inside the worker / Python helper.
    // Keep this in sync with the default in services/videoGen/local.js.
    const effectiveNumFrames = body.numFrames != null ? Number(body.numFrames) : DEFAULT_NUM_FRAMES;
    resolvedKeyframes = [];
    let prevIndex = -1;
    for (let i = 0; i < body.keyframes.length; i++) {
      const kf = body.keyframes[i];
      const path = resolveGalleryImage(kf.file);
      if (!path) {
        await cleanupStaged();
        throw new ServerError(
          `keyframes[${i}].file not found in gallery: ${kf.file}`,
          { status: 400, code: 'KEYFRAME_GALLERY_MISS' },
        );
      }
      if (kf.index <= prevIndex) {
        await cleanupStaged();
        throw new ServerError(
          `keyframes indices must be strictly ascending; got ${prevIndex} then ${kf.index}`,
          { status: 400, code: 'KEYFRAME_INDICES_NOT_ASCENDING' },
        );
      }
      if (kf.index > effectiveNumFrames - 1) {
        await cleanupStaged();
        const numFramesLabel = body.numFrames != null
          ? `numFrames ${body.numFrames}`
          : `default numFrames ${DEFAULT_NUM_FRAMES}`;
        throw new ServerError(
          `keyframes[${i}].index ${kf.index} >= ${numFramesLabel}`,
          { status: 400, code: 'KEYFRAME_INDEX_OUT_OF_RANGE' },
        );
      }
      resolvedKeyframes.push({ path, index: kf.index });
      prevIndex = kf.index;
    }
  }

  // Resolve a render-history id to its on-disk video under data/videos/.
  // Shared by native extend and the IC-LoRA reference channel: both let the
  // user point at a prior render, and both must reject a missing/tampered id
  // rather than silently degrading to a text render (which would produce
  // wrong-looking content with no error). `label` names the field in the error
  // so the two callers stay distinguishable.
  const resolveHistoryVideoPath = async (id, { history, label, notFoundCode, missingFileCode }) => {
    const videoEntry = history.find((h) => h.id === id);
    if (!videoEntry) {
      // cleanupStaged covers durable copies that may have been written
      // before this validation point — these modes and image uploads are
      // mutually exclusive in the UI but the route doesn't enforce that,
      // so be defensive.
      await cleanupStaged();
      throw new ServerError(`${label} not found in history: ${id}`, { status: 404, code: notFoundCode });
    }
    const candidate = safeUnder(PATHS.videos, videoEntry.filename);
    if (!candidate || !existsSync(candidate)) {
      await cleanupStaged();
      throw new ServerError(
        `${label} resolved to a missing file: ${videoEntry.filename}`,
        { status: 404, code: missingFileCode },
      );
    }
    return candidate;
  };

  // Render history is read by both the extend and IC reference paths. Load it
  // lazily and at most once — the file grows with every render, so a request
  // carrying both would otherwise re-read and re-parse megabytes.
  let historyCache = null;
  const getHistory = async () => (historyCache ??= await loadHistory());

  // Native extend (ltx2 runtime): forward the resolved path as
  // extendFromVideoPath.
  let extendFromVideoPath = null;
  if (body.extendFromVideoId) {
    extendFromVideoPath = await resolveHistoryVideoPath(body.extendFromVideoId, {
      history: await getHistory(),
      label: 'extendFromVideoId',
      notFoundCode: 'EXTEND_SOURCE_NOT_FOUND',
      missingFileCode: 'EXTEND_SOURCE_FILE_MISSING',
    });
  }

  // IC-LoRA reference channel: gallery stills for an image-kind weight, else the
  // staged upload or the picked prior render(s). The route already rejected the
  // cross-kind and both-present cases (and asserted the count against the weight's
  // bounds) above, so exactly one branch contributes and each entry resolves 1:1
  // or throws.
  let icReferencePaths = null;
  if (icSpec) {
    if (icSpec.referenceKind === 'image') {
      // Gallery-only, exactly like `keyframes` — same path-traversal guard, same
      // "reject up-front so the queue never accepts a doomed job" contract. The
      // service materializes each still into a VAE-compatible clip at render
      // resolution (the IC reference channel is a video encoder end-to-end).
      icReferencePaths = [];
      for (let i = 0; i < body.icReferenceImageFiles.length; i++) {
        const file = body.icReferenceImageFiles[i];
        const path = resolveGalleryImage(file);
        if (!path) {
          await cleanupStaged();
          throw new ServerError(
            `icReferenceImageFiles[${i}] not found in gallery: ${file}`,
            { status: 400, code: 'IC_LORA_REFERENCE_GALLERY_MISS' },
          );
        }
        icReferencePaths.push(path);
      }
    } else if (icReferenceUploadPath) {
      icReferencePaths = [icReferenceUploadPath];
    } else {
      const history = await getHistory();
      icReferencePaths = [];
      for (const id of body.icReferenceVideoIds || []) {
        icReferencePaths.push(await resolveHistoryVideoPath(id, {
          history,
          label: 'icReferenceVideoIds entry',
          notFoundCode: 'IC_LORA_REFERENCE_NOT_FOUND',
          missingFileCode: 'IC_LORA_REFERENCE_FILE_MISSING',
        }));
      }
    }
  }

  // Collapse the parallel loraFilenames/loraScales arrays into the internal
  // `[{ filename, scale }]` shape the service (resolveVideoLoras) and the
  // resume param echo consume. A defaulted scale keeps the worker contract
  // simple. Empty (picker cleared) → undefined.
  const loras = Array.isArray(body.loraFilenames) && body.loraFilenames.length
    ? body.loraFilenames.map((filename, i) => ({
        filename,
        scale: typeof body.loraScales?.[i] === 'number' ? body.loraScales[i] : 1.0,
      }))
    : undefined;

  // Video LoRAs fuse on two runtimes: dgrauet's `ltx2` (via the pipeline's
  // _pending_loras hook, see scripts/generate_ltx2.py) and non-quantized
  // LTX-2.x `mlx_video` models (merged offline by scripts/generate_av_lora.py).
  // `minimax_h3` applies them at runtime, but only if the installed checkout
  // passes PortOS's quant-aware adapter probe — listVideoModels() decorates that
  // result as `runtimeLoraCapable`, which videoLoraFamily() reads.
  // videoLoraFamily() returns null for everything else (wan22 / fastvideo /
  // quantized mlx_video) — reject up-front so a bad modelId can't enqueue a
  // doomed job that only fails in the worker.
  if (loras && effectiveModel) {
    // `runtimeLoraCapable` was decorated from a SYNC cache read, which is false
    // on a cold cache. Resolve the probe before rejecting, or the first LoRA
    // render after boot on a capable install would be refused and only heal on
    // retry. Re-derive the flag from the settled verdict rather than trusting
    // the snapshot the model list was built from.
    const runtimeLoraCapable = await resolveByovRuntimeLoraCapable(effectiveModel.runtime);
    if (!videoLoraFamily({ ...effectiveModel, runtimeLoraCapable })) {
      await cleanupStaged();
      throw videoLoraUnsupportedError(effectiveModel, effectiveModelId);
    }
  }

  // a2v and the IC remix modes both anchor a single render (audio track /
  // reference clip), so chaining is meaningless — pin to 1 chunk. The IC path
  // also hard-rejects an explicit chunks>1 above; this covers the default.
  const effectiveChunks = (body.mode === 'a2v' || icSpec) ? 1 : (body.chunks ?? 1);

  // Per-chunk prompt beats (#3695) — only meaningful once the RESOLVED request
  // really chains, so a single-chunk render (or an a2v/IC one pinned to 1 above)
  // drops the list entirely rather than persisting a stale array into job params
  // that a resume would replay into the form.
  //
  // Sizing is forgiving in both directions: a stale overlong list (the user
  // typed beats, then lowered the chunk count) is truncated to the resolved
  // count, and a short list is left short — generateChainedVideo falls back to
  // the main prompt for any index the list doesn't cover. Blank entries become
  // an explicit null (absent beat → main prompt) rather than an empty string the
  // runner would render as an empty prompt. An all-blank list collapses to
  // undefined so "the user cleared every beat" and "no beats were sent" persist
  // identically instead of storing a useless array of nulls.
  const normalizedChunkPrompts = effectiveChunks > 1 && Array.isArray(body.chunkPrompts)
    ? body.chunkPrompts.slice(0, effectiveChunks)
      .map((p) => (typeof p === 'string' && p.trim() !== '' ? p.trim() : null))
    : undefined;
  const effectiveChunkPrompts = normalizedChunkPrompts?.some(Boolean)
    ? normalizedChunkPrompts
    : undefined;

  // Continuation context window — same "only meaningful once the request
  // really chains" rule as the beats above, so a single-chunk render doesn't
  // persist a knob that never applied and a resume can't replay it into the
  // form. Resolved (defaulted + clamped) here rather than at render time so
  // the persisted job records what the chain will actually do; note `0` is a
  // real value (last-frame chaining) and must not be dropped as falsy.
  const effectiveContextFrames = effectiveChunks > 1
    ? resolveContextFrames(body.contextFrames)
    : undefined;

  return {
    backend,
    pythonPath,
    effectiveModel,
    effectiveModelId,
    effectiveNumFrames,
    mode: body.mode,
    sourceImagePath,
    lastImagePath,
    audioFilePath,
    icReferencePaths,
    resolvedKeyframes,
    extendFromVideoPath,
    uploadedTempPath,
    uploadedTempPaths: extraUploadedTempPaths,
    loras,
    effectiveChunks,
    effectiveChunkPrompts,
    effectiveContextFrames,
    discardSourceImage,
    cleanupStaged,
  };
}
