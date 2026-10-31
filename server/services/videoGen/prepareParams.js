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
 *   - hosted backend short-circuit after source-image staging (usability check,
 *     then the backend's own `stageInputs` in hostedSubmission.js)
 *   - keyframe resolution + range checks (resolveKeyframeAnchors)
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
import { randomUUID } from 'crypto';
import { join, extname } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { REFERENCE_AUDIO_FIELDS } from './requestFields.js';
import { PATHS, ensureDir, resolveGalleryImage, copyFileGuarded, unlinkGuarded, assertFileNotMediaManifest } from '../../lib/fileUtils.js';
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
import { wan22FrameCountError } from './wan22Controls.js';
import { resolveContextFrames, resolveContinuityRequest } from '../../lib/videoContinuity.js';
import {
  IC_LORA_MODE_VALUES, icLoraSpecForMode,
  assertIcReferenceCount, describeIcReferenceRange,
} from '../../lib/icLoraWeights.js';
import { getSettings } from '../settings.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { musicVideoLocalClipSize } from '../../lib/musicVideoAspect.js';
import { localModelRendersCutaway, localModelRendersPerformance } from '../../lib/musicVideoLocalModels.js';
import { isPerformanceScene } from '../../lib/musicVideoShotTiming.js';
import { getTrack } from '../tracks/index.js';
import { CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODE, resolveVideoMode } from './modes.js';
import { getFalVideoModel } from '../../lib/falVideoModels.js';
import { HOSTED_VIDEO_SUBMISSIONS } from './hostedSubmission.js';
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
  hardwareUnavailableReason,
  isHardwareCompatible,
  withHardwareCompatibility,
} from '../../lib/systemCapabilities.js';
// Straight from the leaf, not through local.js: the suites that exercise this
// module mock local.js wholesale, and a mocked rule table would assert nothing.
import { videoModeContractError, videoChainUnsupportedError, videoReferenceModeError, videoContinuityContractError } from './modeContract.js';
import { resolveByovRuntimeLoraCapable, videoLoraUnsupportedError } from './runtimes.js';
import { validateVideoBatch } from './batch.js';
import { audioDurationToFrames } from './audioDuration.js';
import { RUNWAY_SPECIAL_VIDEO_MODES } from '../../lib/runwaySpecialVideoModels.js';
import { isMiniMaxH3SpeedProfileRequest } from '../../lib/minimaxH3SpeedProfiles.js';

async function validateMiniMaxH3SpeedParams(model, params, settings) {
  const hasProfile = isMiniMaxH3SpeedProfileRequest(params.speedProfileId);
  if (!hasProfile && ['minimax_h3', 'minimax_h3_cuda'].includes(model?.runtime) && params.speedProfileId && params.speedProfileId !== 'quality') {
    throw new ServerError('This H3 model does not offer the requested speed profile. Select Quality or its listed LightX2V profile.', { status: 400, code: 'VIDEO_SPEED_PROFILE_UNSUPPORTED' });
  }
  if (!hasProfile && (!['minimax_h3', 'minimax_h3_cuda'].includes(model?.runtime) || !params.loras?.length)) return;
  const { prepareMiniMaxH3SpeedProfile, validateMiniMaxH3CudaLoras, validateMiniMaxH3MlxLoras } = await import('./ensureWeights.js');
  const profile = hasProfile ? await prepareMiniMaxH3SpeedProfile({
    ...params, model, profileId: params.speedProfileId,
    mode: params.mode || (params.sourceImagePath ? 'image' : 'text'),
    width: params.width ?? model.defaultWidth,
    height: params.height ?? model.defaultHeight,
  }, settings || await getSettings()) : null;
  if (params.loras?.length) {
    const { resolveVideoLoras } = await import('./renderArgs.js');
    const validate = model.runtime === 'minimax_h3' ? validateMiniMaxH3MlxLoras : validateMiniMaxH3CudaLoras;
    await validate(await resolveVideoLoras(params.loras, { runtime: model.runtime }), profile);
  }
}

// Retries reuse persisted worker parameters instead of passing through the
// multipart preparation path. Keep the model/mode gates here so a model edit
// cannot delete the original history row before the replacement is renderable.
export async function validateVideoRetryParams(params = {}) {
  const needsCuda = (requirements) => requirements?.requiresNvidiaGpu
    || requirements?.minVramGb != null
    || requirements?.minCudaComputeCapability != null;
  let capabilities = captureSystemCapabilities();
  const modelWasOmitted = params.modelId === undefined || params.modelId === '';
  const settings = modelWasOmitted ? await getSettings() : null;
  const preferredId = settings?.videoGen?.defaultModelId;
  let modelId = modelWasOmitted ? defaultVideoModelId(capabilities, preferredId) : params.modelId;
  const knownModels = listVideoModels();
  let model = knownModels.find((entry) => entry.id === modelId);
  if (needsCuda(model?.hardwareRequirements)) {
    capabilities = await detectSystemCapabilities();
    if (modelWasOmitted) modelId = defaultVideoModelId(capabilities, preferredId);
    model = knownModels.find((entry) => entry.id === modelId);
  }
  model = model && withHardwareCompatibility(model, capabilities, model.hardwareRequirements);
  const { validateA2vLoraStages } = await import('./loraStages.js');
  await validateA2vLoraStages({ strengths: params.a2vLoraStageStrengths, model,
    mode: params.mode, hasLoras: params.loras?.length > 0 });
  if (!model) {
    throw new ServerError(`Unknown modelId: ${modelId}`, { status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' });
  }
  if (!isHardwareCompatible(model.hardwareCompatibility)) {
    throw new ServerError(
      hardwareUnavailableReason(`Video model "${modelId}"`, model.hardwareCompatibility),
      { status: 400, code: 'MODEL_HARDWARE_UNAVAILABLE' },
    );
  }
  if (!isStockTextEncoder(params.textEncoderId)
    && !supportsVideoTextEncoder(model, params.textEncoderId)) {
    throw videoTextEncoderUnsupportedError(model, params.textEncoderId);
  }
  const continuityError = videoContinuityContractError({ model, continuityStrategy: params.continuityStrategy, contextFrames: params.contextFrames });
  if (continuityError) throw continuityError;
  validateVideoBatch(params, model);
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
  // A retry replays persisted params past the route, so re-assert the ceilings.
  const retryReferenceError = referenceCountError(model, 'extra reference images', params.referenceImagePaths?.length, extraReferenceImageLimit(model), 'VIDEO_REFERENCE_IMAGES_UNSUPPORTED')
    || referenceCountError(model, 'reference clips', params.referenceVideoPaths?.length, model.maxReferenceVideos, 'VIDEO_REFERENCE_CLIPS_UNSUPPORTED')
    || referenceCountError(model, 'voice clips', params.referenceAudioPaths?.length, model.maxReferenceAudios, 'VIDEO_REFERENCE_AUDIO_UNSUPPORTED');
  if (retryReferenceError) throw retryReferenceError;
  const retryTotalError = referenceTotalError(model, {
    hasFirstImage: Boolean(params.sourceImagePath),
    images: params.referenceImagePaths?.length, videos: params.referenceVideoPaths?.length, audios: params.referenceAudioPaths?.length,
  });
  if (retryTotalError) throw retryTotalError;
  // Staged voice uploads belong to the job that staged them, so a chain's later
  // chunks would reference files chunk zero's cleanup already removed.
  if (Number(params.chunks || 1) > 1 && (params.referenceImagePaths?.length || params.referenceVideoPaths?.length || params.referenceAudioPaths?.length)) {
    throw new ServerError(REFERENCE_CHUNKS_MESSAGE, { status: 400, code: 'VIDEO_REFERENCE_CHUNKS_CONFLICT' });
  }
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
  const frameCountError = wan22FrameCountError(model, numFrames);
  if (frameCountError) throw frameCountError;
  await validateMiniMaxH3SpeedParams(model, params, settings);
  return model;
}

/**
 * Best-effort unlink of every multipart temp file the parser wrote before the
 * handler ran. Exported because the route needs it on the Zod-parse failure
 * path, which happens before this service is ever called.
 *
 * @param {object} uploads - `req.files` keyed by fieldname (may be empty)
 */
const cleanedMultipartUploads = new WeakSet();

export const cleanupMultipartTemp = async (uploads) => {
  if (uploads && typeof uploads === 'object') {
    if (cleanedMultipartUploads.has(uploads)) return;
    cleanedMultipartUploads.add(uploads);
  }
  for (const f of Object.values(uploads || {})) {
    if (f?.path) await unlinkGuarded(f.path).catch(() => {});
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
 * The backend a video request renders on: an explicit `body.backend`, else the
 * pin ladder (below). Shared by the submit path and the Video Gen form's
 * prompt preview, which passes the uploads the form holds as present fields.
 */
export function resolveRequestedVideoBackend({ body, uploads, settings, localOnlyParamKeys }) {
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
    && !body.referenceImageFiles?.length && !body.referenceVideoIds?.length
    && !REFERENCE_AUDIO_FIELDS.some((field) => uploads[field])
    && !body.extendFromVideoId
    && !body.keyframes?.length
    && !body.loraFilenames?.length
    && !(body.chunks != null && Number(body.chunks) > 1);
  // Special Runway workflows may use an install/target pin too. The resolved
  // backend is checked against the workflow before staging any inputs below.
  return body.backend
    || (grokDeliverable || RUNWAY_SPECIAL_VIDEO_MODES.includes(body.mode)
      ? resolveVideoMode(null, settings, { target: body.musicVideo ? RENDER_TARGET.MUSIC_VIDEO : null })
      : VIDEO_GEN_MODE.LOCAL);
}

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
  const backend = resolveRequestedVideoBackend({ body, uploads, settings, localOnlyParamKeys });
  if (backend !== VIDEO_GEN_MODE.LOCAL && body.continuityStrategy != null) {
    await cleanupMultipartTemp(uploads);
    throw new ServerError('Explicit continuation strategy requires a local video backend.', {
      status: 400, code: 'VIDEO_CONTINUITY_UNSUPPORTED',
    });
  }
  const runwaySpecial = backend === VIDEO_GEN_MODE.RUNWAY && RUNWAY_SPECIAL_VIDEO_MODES.includes(body.mode);
  if (!runwaySpecial && (RUNWAY_SPECIAL_VIDEO_MODES.includes(body.mode) || uploads.runwayVideo || uploads.runwayCharacterVideo)) {
    await cleanupMultipartTemp(uploads);
    throw new ServerError('Runway video inputs require the matching Runway video workflow.', { status: 400, code: 'VALIDATION_ERROR' });
  }
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
  const preferredId = settings?.videoGen?.defaultModelId;
  let effectiveModelId = modelWasOmitted ? defaultVideoModelId(capabilities, preferredId) : body.modelId;
  let effectiveModel = knownModels.find((m) => m.id === effectiveModelId);
  if (needsCuda(effectiveModel?.hardwareRequirements)) {
    capabilities = await detectSystemCapabilities();
    if (modelWasOmitted) {
      effectiveModelId = defaultVideoModelId(capabilities, preferredId);
      effectiveModel = knownModels.find((m) => m.id === effectiveModelId);
    }
  }
  effectiveModel = effectiveModel && withHardwareCompatibility(
    effectiveModel,
    capabilities,
    effectiveModel.hardwareRequirements,
  );
  const { validateA2vLoraStages } = await import('./loraStages.js');
  await validateA2vLoraStages({ strengths: body.a2vLoraStageStrengths, model: effectiveModel,
    backend, mode: body.mode, hasLoras: body.loraFilenames?.length > 0 })
    .catch(async (error) => { await cleanupMultipartTemp(uploads); throw error; });
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
  // A local Music Video shot: sized to the project's aspect, and checked
  // against the model its kind of shot needs (musicVideoLocalModels.js).
  let musicVideoContractMode = null;
  if (backend === VIDEO_GEN_MODE.LOCAL && body.musicVideo?.projectId) {
    // A clip's own audio never reaches the music video (the song does), so a
    // model that always renders its audio track is not asked to mute it.
    if (effectiveModel?.supportsDisableAudio === false) delete body.disableAudio;
    const unsized = body.width == null && body.height == null;
    const audioOnlyModel = !!effectiveModel && (!body.mode || body.mode === 'image') && !localModelRendersCutaway(effectiveModel);
    const project = unsized || audioOnlyModel
      ? await Promise.resolve().then(() => getMusicVideoProject(body.musicVideo.projectId))
        .catch(async (error) => { await cleanupMultipartTemp(uploads); throw error; })
      : null;
    // Left unsized it would render the model's 768x512 (3:2) default,
    // cropping its 16:9 still and leaving side gaps in a 16:9 video.
    if (project && unsized) {
      const endFrame = body.mode === 'fflf' || !!body.lastImageFile || !!uploads.lastImage;
      Object.assign(body, musicVideoLocalClipSize(project, effectiveModel, { endFrame }));
    }
    const scene = project?.scenes?.find((entry) => entry.sceneId === body.musicVideo.sceneId);
    if (scene && audioOnlyModel) {
      // An audio-only model (MiniMax H3 Ref2VA) renders a performance shot as
      // the a2v job the performance step builds from the still and the song
      // slice after staging, so its contract is checked as that render.
      if (isPerformanceScene(scene) && localModelRendersPerformance(effectiveModel)) musicVideoContractMode = 'a2v';
      else {
        await cleanupMultipartTemp(uploads);
        throw new ServerError(
          `${effectiveModel.name} renders lip-sync and music-driven shots only, from the still and the song. Pick an image-to-video model such as LTX-2.5 for this cutaway.`,
          { status: 400, code: 'MUSIC_VIDEO_MODEL_NEEDS_PERFORMANCE_SHOT' },
        );
      }
    }
  }
  validateVideoBatch({ ...body, backend }, effectiveModel);
  if (effectiveModel && !isHardwareCompatible(effectiveModel.hardwareCompatibility)) {
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      hardwareUnavailableReason(`Video model "${effectiveModelId}"`, effectiveModel.hardwareCompatibility),
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
  if (!pythonPath && !runtimeBringsOwnVenv
    && !CLOUD_VIDEO_GEN_MODES.includes(backend)) {
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      'Local video generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' },
    );
  }

  // Reference inputs condition a local reference-to-video model only; a hosted
  // lane would enqueue an ordinary render that silently ignores them.
  if (backend !== VIDEO_GEN_MODE.LOCAL
    && (body.referenceImageFiles?.length || body.referenceVideoIds?.length
      || REFERENCE_AUDIO_FIELDS.some((field) => uploads[field]))) {
    await cleanupMultipartTemp(uploads);
    throw new ServerError(
      'Reference images, clips and voice clips are only used by local reference-to-video models.',
      { status: 400, code: 'VIDEO_REFERENCE_INPUTS_LOCAL_ONLY' },
    );
  }

  // Track every durable file we've already copied into PATHS.uploads so a
  // *later* staging failure can roll them back. Without this, staging
  // sourceImage successfully then failing on lastImage would leave the
  // sourceImage durable copy orphaned (the job is never enqueued, so the
  // worker's cleanup never runs).
  const stagedDurablePaths = [];
  const cleanupStaged = async () => {
    for (const p of stagedDurablePaths) await unlinkGuarded(p).catch(() => {});
    await cleanupMultipartTemp(uploads);
  };

  // #3326 — every *explicit* throw below already calls cleanupStaged(), but a
  // plain rejected await (getMusicVideoProject / getTrack / loadHistory) would
  // bubble straight past them and orphan up to the full multipart size cap
  // under data/uploads. One guard around the whole staging region covers every
  // rejection point at once, and stays correct as new awaits are added.
  return withStagedRollback(cleanupStaged, () => resolvePreparedParams({
    body, uploads, settings, backend, pythonPath,
    effectiveModel: runwaySpecial ? null : effectiveModel, effectiveModelId, stagedDurablePaths, cleanupStaged, musicVideoContractMode,
  }));
}

// Ensure the durable uploads dir exists before staging. Wrapped in
// try/catch so a permission/disk failure here still cleans up the
// multipart temp uploads instead of leaking them in the OS temp dir.
async function ensureUploadsDir({ uploads, cleanupStaged }) {
  if (!(uploads.sourceImage || uploads.lastImage || uploads.audioFile || REFERENCE_AUDIO_FIELDS.some((field) => uploads[field]) || uploads.icReference || uploads.runwayVideo || uploads.runwayCharacterVideo)) return;
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

// Multi-keyframe interpolation: resolve each gallery filename to an
// absolute path under PATHS.images via the same path-traversal guard as
// sourceImageFile. Reject up-front when any reference can't be resolved
// so the queue doesn't accept a doomed job. Only valid for fflf mode +
// single-chunk renders (the chain orchestrator pins keyframes only on
// chunk 0; chaining ≥2 chunks with N keyframes has no defined semantic).
// Returns null when the request carries no multi-keyframe list. The checks run
// in this order (the `body.mode` default sits between the LTX-2 and chunk
// checks) and every throw unwinds staged files first.
async function resolveKeyframeAnchors({
  body, effectiveModel, effectiveModelId, sourceImagePath, lastImagePath, cleanupStaged,
}) {
  if (!body.keyframes || body.keyframes.length < 2) return null;
  const reject = async (message, code) => {
    await cleanupStaged();
    throw new ServerError(message, { status: 400, code });
  };
  if (body.mode && body.mode !== 'fflf') {
    await reject(`keyframes is only valid with mode='fflf' (got mode='${body.mode}').`, 'KEYFRAMES_MODE_MISMATCH');
  }
  // Reject mixing keyframes with the legacy 2-keyframe inputs — the
  // worker would silently ignore sourceImage/lastImage when keyframes is
  // present, but staging/resizing them anyway is wasted work and the
  // ambiguity (which one wins?) bites callers later. Force the user to
  // pick one shape per request. Covers both upload paths and the
  // gallery-resolved file fields.
  if (sourceImagePath || lastImagePath || body.sourceImageFile || body.lastImageFile) {
    await reject(
      'keyframes cannot be combined with sourceImage / lastImage inputs — pass each anchor frame as a keyframes[] entry instead.',
      'KEYFRAMES_LEGACY_INPUTS_CONFLICT',
    );
  }
  // Multi-keyframe FFLF is an LTX-2 primitive — the legacy mlx_video
  // pipeline has no equivalent. Mirror the a2v guard above so a bad
  // modelId can't enqueue a doomed job that will only fail in the
  // worker (with KEYFRAMES_REQUIRE_LTX2).
  if (effectiveModel && !isLtx2FamilyRuntime(effectiveModel.runtime)) {
    await reject(
      `keyframes mode requires an ltx2-runtime model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
      'KEYFRAMES_REQUIRE_LTX2',
    );
  }
  // Default mode to 'fflf' when keyframes is set without an explicit mode —
  // otherwise local.js#buildLtx2Args resolves helperMode to 'text' and the
  // keyframes silently disappear.
  if (!body.mode) body.mode = 'fflf';
  if (body.chunks != null && Number(body.chunks) > 1) {
    await reject('keyframes cannot be combined with chunks > 1 — keyframes anchor a single clip.', 'KEYFRAMES_CHUNKS_CONFLICT');
  }
  // Validate keyframe indices against the *effective* numFrames so a
  // request with no explicit `numFrames` (which falls back to the
  // generateVideo default of 121) still rejects out-of-range indices
  // up-front instead of failing late inside the worker / Python helper.
  // Keep this in sync with the default in services/videoGen/local.js.
  const effectiveNumFrames = body.numFrames != null ? Number(body.numFrames) : DEFAULT_NUM_FRAMES;
  const resolved = [];
  let prevIndex = -1;
  for (let i = 0; i < body.keyframes.length; i++) {
    const kf = body.keyframes[i];
    const path = resolveGalleryImage(kf.file);
    if (!path) await reject(`keyframes[${i}].file not found in gallery: ${kf.file}`, 'KEYFRAME_GALLERY_MISS');
    if (kf.index <= prevIndex) {
      await reject(`keyframes indices must be strictly ascending; got ${prevIndex} then ${kf.index}`, 'KEYFRAME_INDICES_NOT_ASCENDING');
    }
    if (kf.index > effectiveNumFrames - 1) {
      const numFramesLabel = body.numFrames != null
        ? `numFrames ${body.numFrames}`
        : `default numFrames ${DEFAULT_NUM_FRAMES}`;
      await reject(`keyframes[${i}].index ${kf.index} >= ${numFramesLabel}`, 'KEYFRAME_INDEX_OUT_OF_RANGE');
    }
    resolved.push({ path, index: kf.index });
    prevIndex = kf.index;
  }
  return resolved;
}

// Local audio is queue-owned whether supplied as an upload or copied from a
// project song. Keep source selection and durable ownership in one step.
async function prepareLocalAudio({ body, uploads, stageUploadDurable, stagedDurablePaths, cleanupStaged }) {
  // Music-video a2v jobs reuse an existing library track rather than uploading
  // the same song for every cut. Copy it into the queue-owned uploads area so
  // the worker may safely delete its input on completion without ever touching
  // the source track under data/music.
  const stageExistingAudioDurable = async (sourcePath) => {
    const ext = extname(sourcePath) || '.bin';
    const durablePath = join(PATHS.uploads, `video-audio-${randomUUID()}${ext}`);
    await copyFileGuarded(sourcePath, durablePath).catch(async (err) => {
      await unlinkGuarded(durablePath).catch(() => {});
      await cleanupStaged();
      throw new ServerError(
        `Failed to stage project audio: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_AUDIO_STAGE_FAILED' },
      );
    });
    stagedDurablePaths.push(durablePath);
    return durablePath;
  };

  let audioFilePath = null;
  if (uploads.audioFile) {
    // a2v: audio file rides through the same durable-staging path as the
    // image uploads. Cleanup tracking via extraUploadedTempPaths so the
    // worker drops it on terminal events the same way it drops lastImage.
    audioFilePath = await stageUploadDurable(uploads.audioFile, 'audio');
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
  }
  return audioFilePath;
}

// A model declares how many of each reference kind it takes (absent = none).
// Returns the refusal for `count` over that ceiling, else null.
const REFERENCE_CHUNKS_MESSAGE = 'Reference images, clips and voice clips condition a single render and cannot be combined with chunks > 1.';

const referenceCountError = (model, noun, count, max, code) => {
  if (!count) return null;
  const limit = Number(max) || 0;
  if (count <= limit) return null;
  return new ServerError(
    limit
      ? `${model?.name || 'This model'} takes at most ${limit} ${noun}; got ${count}.`
      : `${model?.name || 'This model'} does not take ${noun}.`,
    { status: 400, code },
  );
};
// The runtime also caps ALL references together (`maxReferenceTotal`, 12 for Omni),
// independent of the per-kind ceilings. `hasFirstImage` counts the input image.
const referenceTotalError = (model, { hasFirstImage, images = 0, videos = 0, audios = 0 }) => {
  const total = (hasFirstImage ? 1 : 0) + images + videos + audios;
  const limit = Number(model?.maxReferenceTotal) || 0;
  if (!limit || total <= limit) return null;
  return new ServerError(
    `${model?.name || 'This model'} takes at most ${limit} references in total; got ${total}.`,
    { status: 400, code: 'VIDEO_REFERENCE_TOTAL_EXCEEDED' },
  );
};
// `maxReferenceImages` counts the first-frame input as the first image.
const extraReferenceImageLimit = (model) => Math.max(0, (Number(model?.maxReferenceImages) || 0) - 1);

async function resolveAudioFrameCount({ body, audioFilePath, effectiveModel, effectiveNumFrames, cleanupStaged }) {
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
  return effectiveNumFrames;
}

async function prepareVideoReferences({
  body, uploads, effectiveModel, sourceImagePath, getHistory, resolveHistoryVideoPath,
  stageUploadDurable, extraUploadedTempPaths, cleanupStaged,
}) {
  // Extra reference stills for a reference-to-video model. Rejected up-front on
  // a model that declares no `maxReferenceImages` (a silently dropped reference
  // would render a clip that ignores what the user supplied) and past the
  // model's ceiling, which counts the first-frame input as the first image.
  let referenceImagePaths = null;
  if (body.referenceImageFiles?.length) {
    const imageCountError = referenceCountError(effectiveModel, 'extra reference images', body.referenceImageFiles.length, extraReferenceImageLimit(effectiveModel), 'VIDEO_REFERENCE_IMAGES_UNSUPPORTED');
    if (imageCountError) {
      await cleanupStaged();
      throw imageCountError;
    }
    referenceImagePaths = [];
    for (let i = 0; i < body.referenceImageFiles.length; i++) {
      const file = body.referenceImageFiles[i];
      const path = resolveGalleryImage(file);
      if (!path) {
        await cleanupStaged();
        throw new ServerError(
          `referenceImageFiles[${i}] not found in gallery: ${file}`,
          { status: 400, code: 'VIDEO_REFERENCE_IMAGE_GALLERY_MISS' },
        );
      }
      referenceImagePaths.push(path);
    }
  }

  // Ordered clip and voice references, after the same per-model ceilings as the
  // image rows. A history clip already lives under data/videos/ and must survive
  // the render; an uploaded voice clip is staged durably and dropped with the job.
  let referenceVideoPaths = null;
  if (body.referenceVideoIds?.length) {
    const clipCountError = referenceCountError(effectiveModel, 'reference clips', body.referenceVideoIds.length, effectiveModel?.maxReferenceVideos, 'VIDEO_REFERENCE_CLIPS_UNSUPPORTED');
    if (clipCountError) {
      await cleanupStaged();
      throw clipCountError;
    }
    const history = await getHistory();
    referenceVideoPaths = [];
    for (const id of body.referenceVideoIds) {
      referenceVideoPaths.push(await resolveHistoryVideoPath(id, {
        history,
        label: 'referenceVideoIds entry',
        notFoundCode: 'VIDEO_REFERENCE_CLIP_NOT_FOUND',
        missingFileCode: 'VIDEO_REFERENCE_CLIP_FILE_MISSING',
      }));
    }
  }
  let referenceAudioPaths = null;
  const audioUploads = REFERENCE_AUDIO_FIELDS.map((field) => uploads[field]).filter(Boolean);
  if (audioUploads.length) {
    const voiceCountError = referenceCountError(effectiveModel, 'voice clips', audioUploads.length, effectiveModel?.maxReferenceAudios, 'VIDEO_REFERENCE_AUDIO_UNSUPPORTED');
    if (voiceCountError) {
      await cleanupStaged();
      throw voiceCountError;
    }
    referenceAudioPaths = [];
    for (const upload of audioUploads) {
      const path = await stageUploadDurable(upload, 'ref-audio');
      extraUploadedTempPaths.push(path);
      referenceAudioPaths.push(path);
    }
  }

  const hasAnyReference = Boolean(referenceImagePaths?.length || referenceVideoPaths?.length || referenceAudioPaths?.length);
  const referenceConflict = (hasAnyReference && Number(body.chunks) > 1
    ? new ServerError(REFERENCE_CHUNKS_MESSAGE, { status: 400, code: 'VIDEO_REFERENCE_CHUNKS_CONFLICT' })
    : null)
    || referenceTotalError(effectiveModel, {
      hasFirstImage: Boolean(sourceImagePath),
      images: referenceImagePaths?.length, videos: referenceVideoPaths?.length, audios: referenceAudioPaths?.length,
    });
  if (referenceConflict) {
    await cleanupStaged();
    throw referenceConflict;
  }

  return { referenceImagePaths, referenceVideoPaths, referenceAudioPaths };
}

/**
 * Pre-staging IC-LoRA request shape: mode ↔ reference pairing, reference kind,
 * count and runtime. Throws the 400 the route returns; the caller owns cleanup.
 */
function assertIcLoraRequest({ icSpec, body, uploads, effectiveModel, effectiveModelId }) {
  if (!icSpec) {
    if (uploads.icReference || body.icReferenceVideoIds?.length || body.icReferenceImageFiles?.length) {
      throw new ServerError(
        `IC-LoRA reference inputs are only valid with an IC remix mode (${IC_LORA_MODE_VALUES.join(', ')}); got mode='${body.mode || 'unset'}'.`,
        { status: 400, code: 'IC_LORA_MODE_MISMATCH' },
      );
    }
    return;
  }
  // The grok backend short-circuits below this point (it only reads
  // prompt/dims/source-image), so an IC request routed there would enqueue a
  // plain grok render with the reference clip silently dropped. The client's
  // mode bar snaps grok back to text/image, but reject explicitly so a direct
  // caller gets an error instead of a wrong-looking clip.
  if (CLOUD_VIDEO_GEN_MODES.includes(body.backend)) {
    throw new ServerError(
      `${icSpec.label} mode runs on the local ltx2 runtime — it isn't available on the ${body.backend} backend.`,
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
    throw new ServerError(
      `${icSpec.label} mode conditions on still images — pass gallery filenames as icReferenceImageFiles, not icReference / icReferenceVideoIds.`,
      { status: 400, code: 'IC_LORA_REFERENCE_KIND_MISMATCH' },
    );
  }
  if (!wantsImages && body.icReferenceImageFiles?.length) {
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
    throw new ServerError(
      'icReference upload cannot be combined with icReferenceVideoIds — pass one reference shape per request.',
      { status: 400, code: 'IC_LORA_REFERENCE_CONFLICT' },
    );
  }
  // Reference count is the weight's contract, asserted once here against the
  // registry that owns the bounds. Checked before staging so a bad request only
  // unlinks the cheap OS temp file, and resolution can't change the count: an
  // upload is exactly 1, every history id resolves 1:1 or throws, and every
  // gallery filename resolves 1:1 or throws.
  const refCount = wantsImages
    ? (body.icReferenceImageFiles?.length || 0)
    : (uploads.icReference ? 1 : 0) + (body.icReferenceVideoIds?.length || 0);
  if (refCount === 0) {
    // Special-cased ahead of the bounds assertion purely for actionability —
    // "needs exactly 1; got 0" doesn't tell the caller HOW to supply one.
    throw new ServerError(
      wantsImages
        ? `${icSpec.label} mode requires ${describeIcReferenceRange(icSpec)} reference images — pick them from your gallery (icReferenceImageFiles).`
        : `${icSpec.label} mode requires a reference ${icSpec.referenceKind} — upload one (multipart field: icReference) or pick a prior render (icReferenceVideoIds).`,
      { status: 400, code: 'IC_LORA_REFERENCE_REQUIRED' },
    );
  }
  assertIcReferenceCount(icSpec, refCount, (msg) => new ServerError(msg, {
    status: 400, code: 'IC_LORA_REFERENCE_COUNT',
  }));
  // IC-LoRA remix is an LTX-2 primitive (ICLoraPipeline). Fail before enqueue
  // so a bad modelId can't pollute the persisted queue with a doomed job.
  if (effectiveModel && !isLtx2FamilyRuntime(effectiveModel.runtime)) {
    throw new ServerError(
      `${icSpec.label} mode requires an ltx2-runtime model. Model "${effectiveModelId}" runs on "${effectiveModel.runtime || 'mlx_video'}".`,
      { status: 400, code: 'IC_LORA_REQUIRES_LTX2' },
    );
  }
  // Chained renders re-seed each chunk from the previous chunk's last frame;
  // an IC render is conditioned on a whole reference clip instead, so there's
  // no defined semantic for chunk 2+ and it would silently ignore the mode.
  if (body.chunks != null && Number(body.chunks) > 1) {
    throw new ServerError(
      `${icSpec.label} mode cannot be combined with chunks > 1 — the reference clip anchors a single render.`,
      { status: 400, code: 'IC_LORA_CHUNKS_CONFLICT' },
    );
  }
}

/**
 * IC-LoRA reference channel: gallery stills for an image-kind weight, else the
 * staged upload or the picked prior render(s). `assertIcLoraRequest` already
 * rejected the cross-kind and both-present cases and asserted the count, so
 * exactly one branch contributes and each entry resolves 1:1 or throws.
 */
async function resolveIcReferencePaths({
  icSpec, body, icReferenceUploadPath, getHistory, resolveHistoryVideoPath, cleanupStaged,
}) {
  if (icSpec.referenceKind === 'image') {
    // Gallery-only, exactly like `keyframes` — same path-traversal guard, same
    // "reject up-front so the queue never accepts a doomed job" contract. The
    // service materializes each still into a VAE-compatible clip at render
    // resolution (the IC reference channel is a video encoder end-to-end).
    const paths = [];
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
      paths.push(path);
    }
    return paths;
  }
  if (icReferenceUploadPath) return [icReferenceUploadPath];
  const history = await getHistory();
  const paths = [];
  for (const id of body.icReferenceVideoIds || []) {
    paths.push(await resolveHistoryVideoPath(id, {
      history,
      label: 'icReferenceVideoIds entry',
      notFoundCode: 'IC_LORA_REFERENCE_NOT_FOUND',
      missingFileCode: 'IC_LORA_REFERENCE_FILE_MISSING',
    }));
  }
  return paths;
}

// Chain-only request knobs, resolved against the final chunk count.
function resolveChainSettings({ body, effectiveChunks, effectiveModel }) {
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
      .map((p) => (typeof p === 'string' && p.trim() !== '' ? p : null))
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

  const continuation = effectiveChunks > 1 || body.continuityStrategy != null
    ? resolveContinuityRequest({ model: effectiveModel, continuityStrategy: body.continuityStrategy, contextFrames: body.contextFrames })
    : undefined;
  return { effectiveChunkPrompts, effectiveContextFrames, continuation };
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
  effectiveModel, effectiveModelId, stagedDurablePaths, cleanupStaged, musicVideoContractMode = null,
}) {
  // Stage a multipart upload into data/uploads so the queue worker can find
  // it after a server restart — the OS temp dir gets reaped on reboot, and a
  // persisted `queued` job may replay long after the original POST. Worker
  // unlinks the durable file when the job completes or cancels. Throws
  // ServerError on copy failure (and cleans up every staged file + multipart
  // temp upload so a mid-flight failure doesn't leak under /tmp + data/uploads).
  const stageUploadDurable = async (file, kind) => {
    // ffmpeg opens a staged file by its bytes, so a playlist posing as audio
    // or an image never reaches the duration probe or the render.
    await assertFileNotMediaManifest(file.path).catch(async (err) => {
      await cleanupStaged();
      throw err;
    });
    const ext = extname(file.originalname || file.path) || '.bin';
    const durablePath = join(PATHS.uploads, `video-${kind}-${randomUUID()}${ext}`);
    try {
      await copyFileGuarded(file.path, durablePath);
    } catch (err) {
      await unlinkGuarded(durablePath).catch(() => {});
      await cleanupStaged();
      throw new ServerError(
        `Failed to stage upload to durable location: ${err.message}`,
        { status: 500, code: 'VIDEO_GEN_UPLOAD_STAGE_FAILED' },
      );
    }
    await unlinkGuarded(file.path).catch(() => {});
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
  // A fal source-audio model (lip-sync, or audio-to-video motion) takes the frame plus an uploaded
  // audio clip (no Music Video scene needed).
  const falSourceAudio = body.backend === VIDEO_GEN_MODE.FAL && !!getFalVideoModel(body.falModelId)?.audioInput;
  if (falSourceAudio && !uploads.audioFile && !body.musicVideo) {
    await cleanupStaged();
    throw new ServerError('A fal.ai source-audio model needs an audioFile upload (the audio it follows).', { status: 400, code: 'VIDEO_GEN_AUDIO_REQUIRED' });
  }
  if (uploads.audioFile && body.mode !== 'a2v' && !falSourceAudio) {
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
  try {
    assertIcLoraRequest({ icSpec, body, uploads, effectiveModel, effectiveModelId });
  } catch (err) {
    await cleanupStaged();
    throw err;
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
  const continuityError = videoContinuityContractError({ model: effectiveModel,
    continuityStrategy: body.continuityStrategy, contextFrames: body.contextFrames });
  if (continuityError) {
    await cleanupStaged();
    throw continuityError;
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
  const declaredMode = musicVideoContractMode || body.mode || (hasDeclaredFirstImage ? 'image' : 'text');
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
  // Pin Wan's validated count for the worker while preserving other runtimes'
  // existing behavior of leaving omitted controls unset in persisted params.
  const isWan = effectiveModel?.runtime === 'wan22' || effectiveModel?.runtime === 'wan22_cuda';
  let effectiveNumFrames = isWan
    ? body.numFrames ?? effectiveModel.defaultFrames ?? DEFAULT_NUM_FRAMES
    : body.numFrames;
  const frameCountError = wan22FrameCountError(effectiveModel, effectiveNumFrames);
  if (frameCountError) {
    await cleanupStaged();
    throw frameCountError;
  }

  let sourceImagePath = null;
  let lastImagePath = null;
  let icReferenceUploadPath = null;
  let uploadedTempPath = null;
  const extraUploadedTempPaths = [];
  await ensureUploadsDir({ uploads, cleanupStaged });
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
      await unlinkGuarded(uploadedTempPath).catch(() => {});
      const index = stagedDurablePaths.indexOf(uploadedTempPath);
      if (index >= 0) stagedDurablePaths.splice(index, 1);
    }
    if (uploads.sourceImage?.path) await unlinkGuarded(uploads.sourceImage.path).catch(() => {});
  };
  // Hosted workers consume staged frames and supported source audio, but none
  // of the local runtime/IC machinery below. Keep availability checking here
  // so failures retain source validation precedence and staged-file ownership.
  const hosted = HOSTED_VIDEO_SUBMISSIONS[backend];
  if (hosted) {
    const { usable, extras } = hosted.prepare(settings);
    if (!usable) {
      await cleanupStaged();
      throw new ServerError(hosted.errorMessage, { status: 400, code: hosted.errorCode });
    }
    const staged = await hosted.stageInputs({
      body, uploads, sourceImagePath, falSourceAudio, stageUploadDurable, cleanupStaged,
    });
    return {
      backend,
      ...extras,
      effectiveModel: { id: backend, supportedModes: ['text', 'image'] },
      sourceImagePath,
      uploadedTempPath,
      ...staged,
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
  const audioFilePath = await prepareLocalAudio({
    body, uploads, stageUploadDurable, stagedDurablePaths, cleanupStaged,
  });
  if (audioFilePath) extraUploadedTempPaths.push(audioFilePath);
  effectiveNumFrames = await resolveAudioFrameCount({
    body, audioFilePath, effectiveModel, effectiveNumFrames, cleanupStaged,
  });
  if (uploads.icReference) {
    // IC-LoRA reference clip — same durable staging + cleanup tracking as the
    // audio upload above. A history-picked reference needs neither (it already
    // lives under data/videos/ and must survive the render).
    icReferenceUploadPath = await stageUploadDurable(uploads.icReference, 'ic-ref');
    extraUploadedTempPaths.push(icReferenceUploadPath);
  }

  const resolvedKeyframes = await resolveKeyframeAnchors({
    body, effectiveModel, effectiveModelId, sourceImagePath, lastImagePath, cleanupStaged,
  });

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

  const icReferencePaths = icSpec
    ? await resolveIcReferencePaths({
      icSpec, body, icReferenceUploadPath, getHistory, resolveHistoryVideoPath, cleanupStaged,
    })
    : null;

  const { referenceImagePaths, referenceVideoPaths, referenceAudioPaths } = await prepareVideoReferences({
    body, uploads, effectiveModel, sourceImagePath, getHistory, resolveHistoryVideoPath,
    stageUploadDurable, extraUploadedTempPaths, cleanupStaged,
  });

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
  await validateMiniMaxH3SpeedParams(effectiveModel, {
    ...body, loras, sourceImagePath, lastImagePath, keyframes: resolvedKeyframes,
    extendFromVideoPath, audioFilePath,
  }, settings).catch(async (error) => { await cleanupStaged(); throw error; });

  const { effectiveChunkPrompts, effectiveContextFrames, continuation } = resolveChainSettings({
    body, effectiveChunks, effectiveModel,
  });

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
    referenceImagePaths,
    referenceVideoPaths,
    referenceAudioPaths,
    resolvedKeyframes,
    extendFromVideoPath,
    uploadedTempPath,
    uploadedTempPaths: extraUploadedTempPaths,
    loras,
    effectiveChunks,
    effectiveChunkPrompts,
    effectiveContextFrames,
    continuation,
    discardSourceImage,
    cleanupStaged,
  };
}
