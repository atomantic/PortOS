/** Validates video model, backend and input contracts for submission and retry. */

import { ServerError } from '../../lib/errorHandler.js';
import {
  REFERENCE_AUDIO_FIELDS,
  VIDEO_REFERENCE_IMAGE_FIELDS,
  MAX_VIDEO_REFERENCE_IMAGES,
  videoReferenceImageSlots,
} from './requestFields.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { videoLoraFamily, isMiniMaxH3Runtime, isLtx2FamilyRuntime, isAudioToVideoRuntime } from '../../lib/runners.js';
import { isStockTextEncoder, supportsVideoTextEncoder, videoTextEncoderUnsupportedError } from '../../lib/videoTextEncoders.js';
import { minimaxH3ControlError } from './minimaxH3Controls.js';
import { wan22FrameCountError } from './wan22Controls.js';
import {
  IC_LORA_MODE_VALUES,
  icLoraSpecForMode,
  icLoraSupportsRuntime,
  icLoraFrameIssue,
  assertIcReferenceCount,
  describeIcReferenceRange,
} from '../../lib/icLoraWeights.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { musicVideoFrameGenSize, musicVideoLocalClipSize } from '../../lib/musicVideo/musicVideoAspect.js';
import { localModelRendersCutaway, localModelRendersPerformance } from '../../lib/musicVideo/musicVideoLocalModels.js';
import { isPerformanceScene } from '../../lib/musicVideo/musicVideoShotTiming.js';
import { CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODE, resolveVideoMode } from './modes.js';
import { getFalVideoModel } from '../../lib/falVideoModels.js';
import { assertReactorNegativePromptSupported } from './negativePrompt.js';
import { storyboardGuidanceRequestError } from './storyboardGuidance.js';
import { isDefaultI2vReferenceMode } from '../../lib/videoReferenceModes.js';
import { listVideoModels, defaultVideoModelId } from './modelCatalog.js';
import { resolveVideoModelSelection } from './modelSelection.js';
import { DEFAULT_NUM_FRAMES, resolveVideoLoras } from './renderArgs.js';
import { hardwareUnavailableReason, isHardwareCompatible } from '../../lib/systemCapabilities.js';
import { videoModeContractError, videoChainUnsupportedError, videoReferenceModeError, videoContinuityContractError } from './modeContract.js';
import { BYOV_VIDEO_RUNTIMES, resolveByovRuntimeLoraCapable, videoLoraUnsupportedError } from './runtimes.js';
import { validateVideoBatch } from './batch.js';
import { RUNWAY_SPECIAL_VIDEO_MODES } from '../../lib/runwaySpecialVideoModels.js';
import { isMiniMaxH3SpeedProfileRequest } from '../../lib/minimaxH3SpeedProfiles.js';

// A hosted renderer is picked with `backend`, not `modelId`; say so to an API caller who sends its name.
export const unknownVideoModelMessage = (modelId) => (CLOUD_VIDEO_GEN_MODES.includes(modelId)
  ? `Unknown modelId: ${modelId}. ${modelId} is a renderer: send backend: "${modelId}" instead of modelId`
  : `Unknown modelId: ${modelId}`);

/** Hosted lanes cannot consume the generic reference inputs used by local models, except the image picks of Runway, Higgsfield, Google and a fal model whose catalog entry takes reference images (hostedSubmission.js). */
export function hostedReferenceInputsError({ backend, body, uploads = {} }) {
  if (backend === VIDEO_GEN_MODE.LOCAL) return null;
  const falModel = backend === VIDEO_GEN_MODE.FAL ? getFalVideoModel(body.falModelId) : null;
  const takesImages = backend === VIDEO_GEN_MODE.RUNWAY || backend === VIDEO_GEN_MODE.HIGGSFIELD || backend === VIDEO_GEN_MODE.GOOGLE
    || !!falModel?.referenceImages;
  const refusedImages = !!body.referenceImageFiles?.length && !body.guidanceImageFile && !takesImages;
  const otherReferences = !!body.referenceVideoIds?.length || REFERENCE_AUDIO_FIELDS.some((field) => uploads[field]);
  if (!refusedImages && !otherReferences) return null;
  return new ServerError(refusedImages && !otherReferences && falModel
    ? `${falModel.label} takes no reference images. Pick a fal.ai reference model such as Seedance 2.5 (reference), or drop the reference images.`
    : 'Reference images, clips and voice clips are only used by local reference-to-video models and, for images, Runway, Higgsfield, Veo and fal.ai models that take them.',
  { status: 400, code: 'VIDEO_REFERENCE_INPUTS_LOCAL_ONLY' });
}

/**
 * Extra reference images (`referenceImage1..3` + `referenceLabel1..3`) condition
 * a Grok or Gemini image-to-video render beside its source frame. Any other lane or a
 * request with no source frame would drop them silently, so each is refused with a 400 instead. The caller owns cleanup.
 */
export function referenceImageUploadsError({ backend, body, uploads = {} }) {
  const slots = videoReferenceImageSlots(uploads, body);
  const orphanLabel = VIDEO_REFERENCE_IMAGE_FIELDS.slice(0, MAX_VIDEO_REFERENCE_IMAGES)
    .findIndex((field, i) => String(body[`referenceLabel${i + 1}`] ?? '').trim() && !uploads[field]);
  if (!slots.length && orphanLabel < 0) return null;
  const refuse = (message, code) => new ServerError(message, { status: 400, code });
  if (orphanLabel >= 0) return refuse(`referenceLabel${orphanLabel + 1} needs a matching referenceImage${orphanLabel + 1} upload.`, 'VIDEO_REFERENCE_LABEL_ORPHANED');
  if (slots.length > MAX_VIDEO_REFERENCE_IMAGES) return refuse(`At most ${MAX_VIDEO_REFERENCE_IMAGES} reference images are supported (referenceImage1..${MAX_VIDEO_REFERENCE_IMAGES}).`, 'VIDEO_REFERENCE_IMAGES_TOO_MANY');
  if (backend !== VIDEO_GEN_MODE.GROK && backend !== VIDEO_GEN_MODE.GEMINI) return refuse('referenceImage uploads are only used by the Grok and Gemini backends.', 'VIDEO_REFERENCE_IMAGES_GROK_ONLY');
  if (!uploads.sourceImage && !body.sourceImageFile) return refuse('referenceImage uploads need a source image (sourceImage) to animate.', 'VIDEO_REFERENCE_IMAGES_NEED_SOURCE');
  return null;
}

async function validateMiniMaxH3SpeedParams(model, params) {
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
  }) : null;
  if (params.loras?.length) {
    const validate = model.runtime === 'minimax_h3' ? validateMiniMaxH3MlxLoras : validateMiniMaxH3CudaLoras;
    await validate(await resolveVideoLoras(params.loras, { runtime: model.runtime }), profile);
  }
}

function selectPreparationModel(modelId, resolveSettings) {
  const knownModels = listVideoModels();
  return resolveVideoModelSelection(modelId, {
    resolveSettings,
    resolveModel: (id) => knownModels.find((model) => model.id === id),
    resolveDefaultModelId: defaultVideoModelId,
  });
}

async function validateVideoLoraStages(params, model, backend) {
  const { validateA2vLoraStages } = await import('./loraStages.js');
  await validateA2vLoraStages({ strengths: params.a2vLoraStageStrengths, model,
    backend, mode: params.mode, hasLoras: params.loras?.length > 0 });
}

export function validateVideoSourceContract(model, params, mode, sourceResolved = false) {
  const hasFirstImage = Boolean(params.sourceImagePath);
  const error = videoModeContractError({
    model, mode, hasFirstImage, sourceResolved,
    hasLastImage: Boolean(params.lastImagePath),
    keyframes: params.keyframes,
    extendFromVideo: params.extendFromVideoPath,
    audioFile: params.audioFilePath,
    icReferences: params.icReferencePaths,
  }) || videoReferenceModeError({ model, mode, hasFirstImage, referenceMode: params.i2vReferenceMode });
  if (error) throw error;
}

function validateModeAndFrameCount(model, params, mode) {
  const modelId = model?.id;
  if (params.keyframes?.length && model && !isLtx2FamilyRuntime(model.runtime)) {
    throw new ServerError(
      `keyframes mode requires an ltx2-runtime model. Model "${modelId}" runs on "${model.runtime || 'mlx_video'}".`,
      { status: 400, code: 'KEYFRAMES_REQUIRE_LTX2' },
    );
  }
  const icSpec = icLoraSpecForMode(mode);
  if (model && mode === 'a2v' && !isAudioToVideoRuntime(model.runtime)) {
    throw new ServerError(
      `a2v mode requires an audio-to-video runtime. Model "${modelId}" runs on "${model.runtime || 'mlx_video'}".`,
      { status: 400, code: 'A2V_RUNTIME_UNSUPPORTED' },
    );
  }
  if (model && icSpec && !icLoraSupportsRuntime(icSpec, model.runtime)) {
    throw new ServerError(
      `${icSpec.label} mode requires a ${icSpec.baseModel} model. Model "${modelId}" runs on "${model.runtime || 'mlx_video'}".`,
      { status: 400, code: 'IC_LORA_REQUIRES_LTX2' },
    );
  }
  const numFrames = params.numFrames ?? model?.defaultFrames ?? DEFAULT_NUM_FRAMES;
  const icFrameIssue = icLoraFrameIssue(icSpec, numFrames);
  if (icFrameIssue) throw new ServerError(icFrameIssue, { status: 400, code: 'IC_LORA_REFERENCE_TOO_SHORT' });
  if (mode === 'ic-ingredients-25' && (params.icSkipStage2 === true || params.icSkipStage2 === 'true')) {
    throw new ServerError('LTX 2.5 References requires the refinement stage.',
      { status: 400, code: 'IC_LORA_SKIP_STAGE2_UNSUPPORTED' });
  }
  if (Number(params.chunks ?? 1) > 1) {
    if (params.keyframes?.length) {
      throw new ServerError('keyframes cannot be combined with chunks > 1 — keyframes anchor a single clip.',
        { status: 400, code: 'KEYFRAMES_CHUNKS_CONFLICT' });
    }
    if (icSpec || params.icReferencePaths?.length) {
      throw new ServerError(
        `${icSpec?.label || 'IC-LoRA'} mode cannot be combined with chunks > 1 — the reference clip anchors a single render.`,
        { status: 400, code: 'IC_LORA_CHUNKS_CONFLICT' },
      );
    }
    const chainError = videoChainUnsupportedError(model);
    if (chainError) throw chainError;
  }
  return numFrames;
}

// Submit checks declared inputs before copying uploads. Retry uses the same
// contract on worker params before it can replace the original history row.
// Reference totals and LoRAs are checked after submit resolves their inputs.
function validateLocalVideoContract(model, params, mode) {
  const modelId = model?.id;
  validateVideoBatch(params, model);
  if (model && !isHardwareCompatible(model.hardwareCompatibility)) {
    throw new ServerError(
      hardwareUnavailableReason(`Video model "${modelId}"`, model.hardwareCompatibility),
      { status: 400, code: 'MODEL_HARDWARE_UNAVAILABLE' },
    );
  }
  if (model && !isStockTextEncoder(params.textEncoderId) && !supportsVideoTextEncoder(model, params.textEncoderId)) {
    throw videoTextEncoderUnsupportedError(model, params.textEncoderId);
  }
  const continuityError = videoContinuityContractError({ model, continuityStrategy: params.continuityStrategy, contextFrames: params.contextFrames });
  if (continuityError) throw continuityError;

  const numFrames = validateModeAndFrameCount(model, params, mode);
  validateVideoSourceContract(model, params, mode);
  if (isMiniMaxH3Runtime(model?.runtime)) {
    const controlError = minimaxH3ControlError({ ...params, model, numFrames, fps: params.fps ?? 24 });
    if (controlError) throw controlError;
  }
  const frameCountError = wan22FrameCountError(model, numFrames);
  if (frameCountError) throw frameCountError;
  return numFrames;
}

export async function validateVideoLorasAndSpeed(model, params) {
  if (model && Array.isArray(params.loras) && params.loras.length) {
    // A cold catalog cache can understate the installed runtime's capability.
    const runtimeLoraCapable = await resolveByovRuntimeLoraCapable(model.runtime);
    if (!videoLoraFamily({ ...model, runtimeLoraCapable })) {
      throw videoLoraUnsupportedError(model, model.id);
    }
  }
  await validateMiniMaxH3SpeedParams(model, params);
}

export async function validateVideoRetryParams(params = {}) {
  const { model, modelId } = await selectPreparationModel(params.modelId);
  await validateVideoLoraStages(params, model);
  if (!model) {
    throw new ServerError(unknownVideoModelMessage(modelId), { status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' });
  }

  const mode = params.mode || (params.sourceImagePath ? 'image' : 'text');
  validateLocalVideoContract(model, params, mode);
  validateReferenceLimits(model, {
    images: params.referenceImagePaths?.length,
    videos: params.referenceVideoPaths?.length,
    audios: params.referenceAudioPaths?.length,
  });
  validateResolvedReferences(model, params);
  await validateVideoLorasAndSpeed(model, params);
  return model;
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
export const extraReferenceImageLimit = (model) => Math.max(0, (Number(model?.maxReferenceImages) || 0) - 1);

export function validateReferenceLimits(model, { images, videos, audios }) {
  const error = referenceCountError(model, 'extra reference images', images, extraReferenceImageLimit(model), 'VIDEO_REFERENCE_IMAGES_UNSUPPORTED')
    || referenceCountError(model, 'reference clips', videos, model?.maxReferenceVideos, 'VIDEO_REFERENCE_CLIPS_UNSUPPORTED')
    || referenceCountError(model, 'voice clips', audios, model?.maxReferenceAudios, 'VIDEO_REFERENCE_AUDIO_UNSUPPORTED');
  if (error) throw error;
}

export function validateResolvedReferences(model, { sourceImagePath, referenceImagePaths, referenceVideoPaths, referenceAudioPaths, chunks }) {
  const images = referenceImagePaths?.length;
  const videos = referenceVideoPaths?.length;
  const audios = referenceAudioPaths?.length;
  // The first chunk owns staged voice uploads and removes them on completion.
  if ((images || videos || audios) && Number(chunks) > 1) {
    throw new ServerError(REFERENCE_CHUNKS_MESSAGE, { status: 400, code: 'VIDEO_REFERENCE_CHUNKS_CONFLICT' });
  }
  const error = referenceTotalError(model, { hasFirstImage: Boolean(sourceImagePath), images, videos, audios });
  if (error) throw error;
}

/**
 * Pre-staging IC-LoRA request shape: mode ↔ reference pairing, reference kind,
 * and count. The shared model contract checks the runtime and controls.
 */
function assertIcLoraRequest({ icSpec, body, uploads, backend }) {
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
  if (CLOUD_VIDEO_GEN_MODES.includes(backend)) {
    throw new ServerError(
      `${icSpec.label} mode runs on the local ltx2 runtime — it isn't available on the ${backend} backend.`,
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
}

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
    // A storyboard panel's references are the guided render's own inputs (storyboardGuidance.js).
    && (body.guidanceImageFile || !body.referenceImageFiles?.length) && !body.referenceVideoIds?.length
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

export async function resolveVideoRequestModel({ backend, body, uploads, settings }) {
  assertReactorNegativePromptSupported(backend, body.negativePrompt);
  if (backend !== VIDEO_GEN_MODE.LOCAL && body.continuityStrategy != null) {
    throw new ServerError('Explicit continuation strategy requires a local video backend.', {
      status: 400, code: 'VIDEO_CONTINUITY_UNSUPPORTED',
    });
  }
  const guidanceError = storyboardGuidanceRequestError({ body, uploads, backend });
  if (guidanceError) {
    throw guidanceError;
  }
  const referenceUploadsError = referenceImageUploadsError({ backend, body, uploads });
  if (referenceUploadsError) {
    throw referenceUploadsError;
  }
  const runwaySpecial = backend === VIDEO_GEN_MODE.RUNWAY && RUNWAY_SPECIAL_VIDEO_MODES.includes(body.mode);
  if (!runwaySpecial && (RUNWAY_SPECIAL_VIDEO_MODES.includes(body.mode) || uploads.runwayVideo || uploads.runwayCharacterVideo)) {
    throw new ServerError('Runway video inputs require the matching Runway video workflow.', { status: 400, code: 'VALIDATION_ERROR' });
  }
  // A loose reference (#4874) is a LOCAL-runtime capability. The model gate
  // further down asks whether the chosen model's runtime can honor it — but an
  // explicit `backend: 'grok'` never reaches that runtime at all: grok's
  // image_to_video always anchors, and its short-circuit below drops every
  // local-only knob. Rejecting here (before any staging) is what keeps
  // "Inspire" from quietly returning an anchored clip from the cloud lane.
  if (backend !== VIDEO_GEN_MODE.LOCAL && !isDefaultI2vReferenceMode(body.i2vReferenceMode)) {
    throw new ServerError(
      `The ${backend} backend always anchors a reference image as frame one — switch to a local LTX-2.5 model, or use the Anchor reference mode.`,
      { status: 400, code: 'I2V_REFERENCE_MODE_UNSUPPORTED' },
    );
  }
  const pythonPath = settings.imageGen?.local?.pythonPath || null;
  const { model: effectiveModel, modelId: effectiveModelId } = await selectPreparationModel(body.modelId, () => settings);
  await validateVideoLoraStages({ ...body, loras: body.loraFilenames }, effectiveModel, backend);
  // Hosted renders can run without a local model when the caller omitted it.
  if (!effectiveModel && (backend === VIDEO_GEN_MODE.LOCAL || body.modelId !== undefined)) {
    throw new ServerError(
      unknownVideoModelMessage(effectiveModelId),
      { status: 400, code: 'VIDEO_GEN_UNKNOWN_MODEL' },
    );
  }

  const musicVideoContractMode = await prepareMusicVideoShot({ backend, body, uploads, effectiveModel });
  // Reference inputs condition a local reference-to-video model only; a hosted
  // lane would enqueue an ordinary render that silently ignores them.
  const hostedReferenceError = hostedReferenceInputsError({ backend, body, uploads });
  if (hostedReferenceError) {
    throw hostedReferenceError;
  }
  return { pythonPath, effectiveModel: runwaySpecial ? null : effectiveModel, effectiveModelId, musicVideoContractMode };
}

async function prepareMusicVideoShot({ backend, body, uploads, effectiveModel }) {
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
      ? await getMusicVideoProject(body.musicVideo.projectId)
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
        throw new ServerError(
          `${effectiveModel.name} renders lip-sync and music-driven shots only, from the still and the song. Pick an image-to-video model such as LTX-2.5 for this cutaway.`,
          { status: 400, code: 'MUSIC_VIDEO_MODEL_NEEDS_PERFORMANCE_SHOT' },
        );
      }
    }
  }
  // A Grok shot sent without a size names no resolution_name, so Grok falls back
  // to its 480p default (848x480 at 16:9); size it to the project's frame instead.
  if (backend === VIDEO_GEN_MODE.GROK && body.musicVideo?.projectId && body.width == null && body.height == null) {
    const project = await getMusicVideoProject(body.musicVideo.projectId);
    if (project) Object.assign(body, musicVideoFrameGenSize(project));
  }
  return musicVideoContractMode;
}

export function validateDeclaredInputs({ body, uploads, backend, effectiveModel, pythonPath, musicVideoContractMode }) {
  // Mode/upload pairing checks BEFORE staging so a rejected request only
  // unlinks the OS temp file (cheap) instead of also unlinking a freshly-
  // copied 100MB durable file under data/uploads (wasted disk I/O on every
  // bad request).
  if (body.mode === 'a2v' && !uploads.audioFile && !body.musicVideo) {
    throw new ServerError(
      'a2v mode requires an audioFile upload or a music-video project audio source.',
      { status: 400, code: 'VIDEO_GEN_AUDIO_REQUIRED' },
    );
  }
  // A fal source-audio model (lip-sync, or audio-to-video motion) takes the frame plus an uploaded
  // audio clip (no Music Video scene needed).
  const falSourceAudio = body.backend === VIDEO_GEN_MODE.FAL && !!getFalVideoModel(body.falModelId)?.audioInput;
  if (falSourceAudio && !uploads.audioFile && !body.musicVideo) {
    throw new ServerError('A fal.ai source-audio model needs an audioFile upload (the audio it follows).', { status: 400, code: 'VIDEO_GEN_AUDIO_REQUIRED' });
  }
  if (uploads.audioFile && body.mode !== 'a2v' && !falSourceAudio) {
    throw new ServerError(
      `audioFile upload is only valid with mode='a2v' (got mode='${body.mode || 'unset'}').`,
      { status: 400, code: 'VIDEO_GEN_AUDIO_MODE_MISMATCH' },
    );
  }
  // IC-LoRA remix (mode='ic-control', …). Mirrors the a2v pairing checks: the
  // reference channel is what makes the mode meaningful, and an IC upload
  // outside an IC mode would be silently dropped by the worker.
  const icSpec = icLoraSpecForMode(body.mode);
  assertIcLoraRequest({ icSpec, body, uploads, backend });

  // Pin the mode from the declared shape so a missing gallery file cannot
  // turn a requested image render into a text render at the resolved pass.
  const contractParams = {
    ...body,
    backend,
    sourceImagePath: uploads.sourceImage || body.sourceImageFile,
    lastImagePath: uploads.lastImage || body.lastImageFile,
    extendFromVideoPath: body.extendFromVideoId,
    audioFilePath: uploads.audioFile || body.musicVideo,
  };
  const declaredMode = musicVideoContractMode || body.mode || (contractParams.sourceImagePath ? 'image' : 'text');
  const validatedNumFrames = validateLocalVideoContract(effectiveModel, contractParams, declaredMode);

  // BYOV runtimes resolve their own environments. Legacy mlx_video requires
  // the configured Python path before a job can be queued.
  const runtimeBringsOwnVenv = effectiveModel && BYOV_VIDEO_RUNTIMES.has(effectiveModel.runtime);
  if (!pythonPath && !runtimeBringsOwnVenv && !CLOUD_VIDEO_GEN_MODES.includes(backend)) {
    throw new ServerError(
      'Local video generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' },
    );
  }

  // Persist Wan's validated count so the worker uses the same default.
  const isWan = effectiveModel?.runtime === 'wan22' || effectiveModel?.runtime === 'wan22_cuda';
  const effectiveNumFrames = isWan ? validatedNumFrames : body.numFrames;
  return { effectiveNumFrames, declaredMode, contractParams, falSourceAudio, icSpec };
}
