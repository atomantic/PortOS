import { isDefaultA2vLoraStages } from '../../lib/videoLoraStageValidation.js';
/**
 * Hosted preparation policy and provider-specific queue fields. Configuration
 * is read from this submission's live settings; fal/Reactor credentials never
 * enter prepared output or persisted params (their workers resolve them).
 */
import { ServerError } from '../../lib/errorHandler.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { probeVideoDuration } from '../../lib/ffmpeg.js';
import { FAL_DEFAULT_IMAGE_VIDEO_MODEL, FAL_DEFAULT_TEXT_VIDEO_MODEL, getFalVideoModel } from '../../lib/falVideoModels.js';
import { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, RUNWAY_FORM_REFERENCE_LABEL, getRunwayVideoModel, runwayModelTakesText } from '../../lib/runwayVideoModels.js';
import { isDefaultI2vReferenceMode } from '../../lib/videoReferenceModes.js';
import { VIDEO_GEN_MODE, isVideoModeUsable } from './modes.js';
import { getRunwaySpecialVideoModel, buildRunwaySpecialVideoRequest } from '../../lib/runwaySpecialVideoModels.js';
import { validateRunwayVideoInput } from './runwayVideoInputs.js';
import { storyboardGuidanceJobParams } from './storyboardGuidance.js';
import { videoReferenceImageSlots } from './requestFields.js';
import { GEMINI_OMNI_WEB_MODEL } from '../../lib/geminiWebVideo.js';
import { HIGGSFIELD_DEFAULT_VIDEO_MODEL, buildHiggsfieldVideoRequest } from '../../lib/higgsfieldVideoModels.js';
import { VERTEX_DEFAULT_VIDEO_MODEL, buildVertexVideoRequest } from '../../lib/vertexVideoModels.js';

// Every hosted backend anchors a reference image as frame one, so a loose
// reference mode is a local-runtime promise it can never keep. Submission
// refuses it up front (prepareParams); a retry replays persisted params past
// that gate, so the same refusal has to be stated here (#4874).
const assertAnchoredReference = (backend, params) => {
  if (!isDefaultA2vLoraStages(params.a2vLoraStageStrengths)) {
    throw new ServerError('Hosted video cannot honor per-stage user LoRA strengths.', { status: 400, code: 'A2V_LORA_STAGES_UNSUPPORTED' });
  }
  if (isDefaultI2vReferenceMode(params.i2vReferenceMode)) return;
  throw new ServerError(
    `The ${backend} backend always anchors a reference image as frame one — retry this job with the Anchor reference mode, or render it locally on LTX-2.5.`,
    { status: 400, code: 'I2V_REFERENCE_MODE_UNSUPPORTED' },
  );
};

// Reactor takes no staged inputs beyond the source frame the caller already owns.
const NO_STAGED_INPUTS = async () => ({});

// Grok's and Gemini's extra reference images (referenceImage1..3): staged durably in
// slot order, each paired with its label. The queue owns the copies (uploadedTempPaths)
// and the worker removes them on every terminal path.
async function stageCastReferenceImages({ body, uploads, stageUploadDurable }) {
  const castReferences = [];
  for (const { file, label } of videoReferenceImageSlots(uploads, body)) {
    castReferences.push({ path: await stageUploadDurable(file, 'reference'), label });
  }
  return castReferences.length ? { castReferences, uploadedTempPaths: castReferences.map((ref) => ref.path) } : {};
}

// fal end frame: refuse a model whose catalog entry takes none, then stage an
// upload durably (the queue owns the copy) or resolve a gallery pick. Throws
// leave cleanup to the caller's rollback guard, as the inlined block did.
async function stageFalEndFrame({ body, uploads, sourceImagePath, stageUploadDurable }) {
  if (!uploads.lastImage && !body.lastImageFile) return null;
  const modelId = body.falModelId || (sourceImagePath ? FAL_DEFAULT_IMAGE_VIDEO_MODEL : FAL_DEFAULT_TEXT_VIDEO_MODEL);
  const model = getFalVideoModel(modelId);
  if (!model?.endImage) {
    throw new ServerError(model ? `${model.label} takes no end frame` : 'End frames require a fal.ai model with catalogued end-frame support',
      { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (uploads.lastImage) {
    const staged = await stageUploadDurable(uploads.lastImage, 'last');
    return { path: staged, owned: true };
  }
  const resolved = resolveGalleryImage(body.lastImageFile);
  if (!resolved) {
    throw new ServerError('The end frame is missing or could not be resolved.', { status: 400, code: 'VALIDATION_ERROR' });
  }
  return { path: resolved, owned: false };
}

// Stage an end frame durably (an upload) or resolve a gallery pick.
async function stageEndFrame({ body, uploads, stageUploadDurable }) {
  if (uploads.lastImage) return { path: await stageUploadDurable(uploads.lastImage, 'last'), owned: true };
  const resolved = resolveGalleryImage(body.lastImageFile);
  if (!resolved) {
    throw new ServerError('The end frame is missing or could not be resolved.', { status: 400, code: 'VALIDATION_ERROR' });
  }
  return { path: resolved, owned: false };
}

// Runway renders from a start frame (an end frame on the models that take one),
// or from text alone on a model with a text-to-video rule.
async function stageRunwayInputs(ctx) {
  const { body, uploads, sourceImagePath, cleanupStaged } = ctx;
  const refuse = async (message) => {
    await cleanupStaged();
    throw new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
  };
  if (uploads.audioFile) await refuse('Runway renders cutaways only; it takes no source audio.');
  const special = getRunwaySpecialVideoModel(body.runwayModelId);
  if (special) {
    if ((uploads.sourceImage || body.sourceImageFile) && !sourceImagePath) await refuse('The requested Runway guidance or character image could not be resolved.');
    buildRunwaySpecialVideoRequest({
      modelId: special.id, videoMode: body.mode, prompt: body.prompt, negativePrompt: body.negativePrompt,
      videoUri: uploads.runwayVideo ? 'pending:video' : null,
      characterVideoUri: uploads.runwayCharacterVideo ? 'pending:character' : null,
      imageUri: sourceImagePath, endImageUri: uploads.lastImage || body.lastImageFile,
      bodyControl: body.runwayBodyControl, expressionIntensity: body.runwayExpressionIntensity,
      targetAspectRatio: body.runwayTargetAspect, ratio: body.runwayRatio, seed: body.runwaySeed,
    });
    const runwayVideoPath = await ctx.stageUploadDurable(uploads.runwayVideo, 'runway-video');
    await validateRunwayVideoInput(runwayVideoPath, special);
    const runwayCharacterVideoPath = uploads.runwayCharacterVideo ? await ctx.stageUploadDurable(uploads.runwayCharacterVideo, 'runway-character') : null;
    if (runwayCharacterVideoPath) await validateRunwayVideoInput(runwayCharacterVideoPath, special, { character: true });
    return { runwayVideoPath, runwayCharacterVideoPath, uploadedTempPaths: [runwayVideoPath, runwayCharacterVideoPath].filter(Boolean) };
  }
  if (uploads.runwayVideo || uploads.runwayCharacterVideo || !['text', 'image', undefined].includes(body.mode)) await refuse('Choose the Runway model matching these video inputs.');
  const model = getRunwayVideoModel(body.runwayModelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL);
  if (!model) await refuse(`"${body.runwayModelId}" is not a Runway model PortOS offers`);
  if (!sourceImagePath && !runwayModelTakesText(model)) await refuse(`${model.label} renders from a start frame — supply a source image.`);
  if (!sourceImagePath && (uploads.lastImage || body.lastImageFile)) await refuse('An end frame needs a start frame — supply a source image.');
  const hasEndFrame = !!uploads.lastImage || !!body.lastImageFile;
  if (hasEndFrame && !model.endImage) await refuse(`${model.label} takes no end frame`);
  // A Music Video clip resolves its shot's references when it is queued (submitJob.js).
  const pickedReferences = body.musicVideo ? [] : body.referenceImageFiles || [];
  if (pickedReferences.length) {
    if (!model.referenceImages) await refuse(`${model.label} takes no reference images.`);
    if (!sourceImagePath) await refuse('Reference images need a start frame — supply a source image.');
    if (hasEndFrame && !model.referenceImages.keepsFrames) await refuse(`${model.label} cannot combine an end frame with reference images. Turn one of them off.`);
    if (pickedReferences.length + (hasEndFrame ? 2 : 1) > model.referenceImages.max) await refuse(`${model.label} takes at most ${model.referenceImages.max} images, its frames included.`);
  }
  const referenceImagePaths = [];
  for (const file of pickedReferences) {
    const path = resolveGalleryImage(file);
    if (!path) await refuse(`The reference image ${file} could not be found in the gallery.`);
    referenceImagePaths.push(path);
  }
  const references = referenceImagePaths.length ? { referenceImagePaths } : {};
  if (!hasEndFrame) return references;
  const endFrame = await stageEndFrame(ctx);
  return { ...references, lastImagePath: endFrame.path, ...(endFrame.owned ? { uploadedTempPaths: [endFrame.path] } : {}) };
}

// Higgsfield renders a cutaway from a prompt, a start frame (optionally with an
// end frame) or gallery reference images. The catalog dry run refuses a
// combination the chosen family cannot take before anything is staged.
async function stageHiggsfieldInputs(ctx) {
  const { body, uploads, sourceImagePath, cleanupStaged } = ctx;
  const refuse = async (message) => {
    await cleanupStaged();
    throw new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
  };
  if (uploads.audioFile) await refuse('Use the shot’s Song audio control for a Higgsfield song reference.');
  const hasEndFrame = !!uploads.lastImage || !!body.lastImageFile;
  const pickedReferences = body.referenceImageFiles || [];
  try {
    buildHiggsfieldVideoRequest({
      modelId: body.higgsfieldModelId || HIGGSFIELD_DEFAULT_VIDEO_MODEL, prompt: body.prompt, negativePrompt: body.negativePrompt,
      imageUrl: sourceImagePath && !pickedReferences.length && !body.musicVideo?.songAudio ? 'pending:image' : null, endImageUrl: hasEndFrame ? 'pending:end-image' : null,
      referenceImageUrls: pickedReferences.map((_, i) => `pending:reference-${i + 1}`),
    });
  } catch (err) {
    await refuse(err.message);
  }
  const referenceImagePaths = [];
  for (const file of pickedReferences) {
    const path = resolveGalleryImage(file);
    if (!path) await refuse(`The reference image ${file} could not be found in the gallery.`);
    referenceImagePaths.push(path);
  }
  const references = referenceImagePaths.length ? { referenceImagePaths } : {};
  if (!hasEndFrame) return references;
  const endFrame = await stageEndFrame(ctx);
  return { ...references, lastImagePath: endFrame.path, ...(endFrame.owned ? { uploadedTempPaths: [endFrame.path] } : {}) };
}

// Veo renders from a prompt, a start frame (optionally with an end frame) or,
// on Veo 3.1, gallery asset reference images. The catalog dry run refuses a
// combination the chosen model cannot take before anything is staged.
async function stageVertexInputs(ctx) {
  const { body, uploads, sourceImagePath, cleanupStaged } = ctx;
  const refuse = async (message) => {
    await cleanupStaged();
    throw new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
  };
  if (uploads.audioFile) await refuse('Vertex AI Veo takes no source audio; turn on Provider audio instead.');
  const hasEndFrame = !!uploads.lastImage || !!body.lastImageFile;
  const pickedReferences = body.musicVideo ? [] : body.referenceImageFiles || [];
  const placeholder = { mimeType: 'image/png', data: '' };
  try {
    buildVertexVideoRequest({
      modelId: body.vertexModelId || VERTEX_DEFAULT_VIDEO_MODEL, prompt: body.prompt, negativePrompt: body.negativePrompt,
      seconds: body.vertexDuration,
      image: sourceImagePath ? placeholder : null, lastImage: hasEndFrame ? placeholder : null,
      referenceImages: pickedReferences.map(() => placeholder),
    });
  } catch (err) {
    await refuse(err.message);
  }
  const referenceImagePaths = [];
  for (const file of pickedReferences) {
    const path = resolveGalleryImage(file);
    if (!path) await refuse(`The reference image ${file} could not be found in the gallery.`);
    referenceImagePaths.push(path);
  }
  const references = referenceImagePaths.length ? { referenceImagePaths } : {};
  if (!hasEndFrame) return references;
  const endFrame = await stageEndFrame(ctx);
  return { ...references, lastImagePath: endFrame.path, ...(endFrame.owned ? { uploadedTempPaths: [endFrame.path] } : {}) };
}

// A standalone fal source-audio take: stage the audio clip durably like the frame. The queue removes
// it if the job fails, is cancelled or is lost to a restart (uploadedTempPaths); the fal worker
// removes it once the take is published.
async function stageFalSourceAudio({ body, uploads, sourceImagePath, stageUploadDurable, cleanupStaged }) {
  if (!uploads.audioFile) return null;
  if (!sourceImagePath) {
    await cleanupStaged();
    throw new ServerError('A fal.ai source-audio render needs a reference frame (sourceImage or sourceImageFile).', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const audioPath = await stageUploadDurable(uploads.audioFile, 'audio');
  // A paid route: refuse a clip fal would reject (unreadable, or outside the model's window)
  // before anything is submitted.
  const window = getFalVideoModel(body.falModelId)?.audioInput || {};
  const clipSec = await probeVideoDuration(audioPath).catch(() => null);
  if (clipSec == null) {
    await cleanupStaged();
    throw new ServerError('Could not read the voice clip\'s duration. Upload a valid WAV, MP3, M4A, AAC, FLAC, OGG or WebM file.',
      { status: 400, code: 'VIDEO_GEN_AUDIO_DURATION_UNREADABLE' });
  }
  if ((window.minSec != null && clipSec < window.minSec) || (window.maxSec != null && clipSec > window.maxSec)) {
    await cleanupStaged();
    throw new ServerError(`The voice clip is ${clipSec.toFixed(2)} s; this model takes ${window.minSec}–${window.maxSec} s (pad a short line with silence).`,
      { status: 400, code: 'VIDEO_GEN_AUDIO_LENGTH' });
  }
  return audioPath;
}

// Stage fal's extra inputs (end frame, then source audio — the order matters
// for rollback). Returns the provider fields plus every queue-owned path.
async function stageFalInputs(ctx) {
  const endFrame = await stageFalEndFrame(ctx);
  const audioFilePath = ctx.falSourceAudio ? await stageFalSourceAudio(ctx) : null;
  const uploadedTempPaths = [...(endFrame?.owned ? [endFrame.path] : []), ...(audioFilePath ? [audioFilePath] : [])];
  return {
    ...(endFrame ? { lastImagePath: endFrame.path } : {}),
    ...(audioFilePath ? { audioFilePath } : {}),
    ...(uploadedTempPaths.length ? { uploadedTempPaths } : {}),
  };
}

export const HOSTED_VIDEO_SUBMISSIONS = {
  [VIDEO_GEN_MODE.GROK]: {
    prepare: (settings) => {
      const grok = settings.imageGen?.grok || {};
      return { usable: grok.enabled, extras: { grok } };
    },
    stageInputs: stageCastReferenceImages,
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.GROK, params),
    errorCode: 'GROK_IMAGEGEN_DISABLED',
    errorMessage: 'Grok Imagegen is disabled — enable it in Settings → Image Gen first',
    buildParams: (body, prepared) => ({
      grokPath: prepared.grok.grokPath,
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio || prepared.grok.aspectRatio,
      width: body.width,
      height: body.height,
      duration: body.grokDuration,
      ...(prepared.uploadedTempPaths?.length ? { uploadedTempPaths: prepared.uploadedTempPaths } : {}),
      ...storyboardGuidanceJobParams(prepared),
    }),
  },
  [VIDEO_GEN_MODE.FAL]: {
    prepare: (settings) => ({
      usable: isVideoModeUsable(settings, VIDEO_GEN_MODE.FAL),
      extras: {},
    }),
    stageInputs: stageFalInputs,
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.FAL, params),
    errorCode: 'FAL_NOT_CONFIGURED',
    errorMessage: 'No fal.ai API key configured — set it in Settings → Video Gen (or the FAL_KEY env var) first',
    // The model, resolution and audio flag are resolved against the curated
    // catalog by videoGen/fal.js (an unsupported resolution falls back to the
    // model's default there); provider audio is off unless asked for.
    buildParams: (body, prepared) => ({
      modelId: body.falModelId,
      ...(prepared.lastImagePath ? { lastImagePath: prepared.lastImagePath } : {}),
      ...(prepared.uploadedTempPaths?.length ? { uploadedTempPaths: prepared.uploadedTempPaths } : {}),
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio,
      width: body.width,
      height: body.height,
      duration: body.falDuration,
      ...(body.falResolution ? { resolution: body.falResolution } : {}),
      ...(body.falGenerateAudio === true ? { generateAudio: true } : {}),
      ...storyboardGuidanceJobParams(prepared),
    }),
  },
  [VIDEO_GEN_MODE.RUNWAY]: {
    prepare: (settings) => ({
      usable: isVideoModeUsable(settings, VIDEO_GEN_MODE.RUNWAY),
      extras: {},
    }),
    stageInputs: stageRunwayInputs,
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.RUNWAY, params),
    errorCode: 'RUNWAY_NOT_CONFIGURED',
    errorMessage: 'No Runway API key configured — set it in Settings → Video Gen (or the RUNWAYML_API_SECRET env var) first',
    // The model, length and size are resolved against the curated catalog by videoGen/runway.js.
    buildParams: (body, prepared) => ({
      modelId: body.runwayModelId,
      videoMode: body.mode,
      ...(prepared.runwayVideoPath ? { runwayVideoPath: prepared.runwayVideoPath, runwayCharacterVideoPath: prepared.runwayCharacterVideoPath } : {}),
      targetAspectRatio: body.runwayTargetAspect, ratio: body.runwayRatio,
      bodyControl: body.runwayBodyControl, expressionIntensity: body.runwayExpressionIntensity, seed: body.runwaySeed,
      ...(prepared.lastImagePath ? { lastImagePath: prepared.lastImagePath } : {}),
      ...(prepared.referenceImagePaths?.length ? {
        referenceImagePaths: prepared.referenceImagePaths,
        clipReferenceLabels: prepared.referenceImagePaths.map(() => ({ label: RUNWAY_FORM_REFERENCE_LABEL })),
      } : {}),
      ...(prepared.uploadedTempPaths?.length ? { uploadedTempPaths: prepared.uploadedTempPaths } : {}),
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio,
      width: body.width,
      height: body.height,
      duration: body.runwayDuration,
      ...(body.runwayResolution ? { resolution: body.runwayResolution } : {}),
    }),
  },
  [VIDEO_GEN_MODE.HIGGSFIELD]: {
    prepare: (settings) => ({ usable: isVideoModeUsable(settings, VIDEO_GEN_MODE.HIGGSFIELD), extras: {} }),
    stageInputs: stageHiggsfieldInputs,
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.HIGGSFIELD, params),
    errorCode: 'HIGGSFIELD_NOT_CONFIGURED',
    errorMessage: 'No Higgsfield credential configured — add it in Settings → Credentials (or the HIGGSFIELD_API_KEY env var) first',
    // The family, length, size and audio flag are resolved against the catalog by videoGen/higgsfield.js.
    buildParams: (body, prepared) => ({
      modelId: body.higgsfieldModelId,
      ...(prepared.lastImagePath ? { lastImagePath: prepared.lastImagePath } : {}),
      ...(prepared.referenceImagePaths?.length ? { referenceImagePaths: prepared.referenceImagePaths } : {}),
      ...(prepared.uploadedTempPaths?.length ? { uploadedTempPaths: prepared.uploadedTempPaths } : {}),
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio,
      width: body.width,
      height: body.height,
      duration: body.higgsfieldDuration,
      ...(body.higgsfieldResolution ? { resolution: body.higgsfieldResolution } : {}),
      ...(body.higgsfieldGenerateAudio === true ? { generateAudio: true } : {}),
      ...(body.higgsfieldSeed != null ? { seed: body.higgsfieldSeed } : {}),
    }),
  },
  [VIDEO_GEN_MODE.VERTEX]: {
    prepare: (settings) => ({ usable: isVideoModeUsable(settings, VIDEO_GEN_MODE.VERTEX), extras: {} }),
    stageInputs: stageVertexInputs,
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.VERTEX, params),
    errorCode: 'VERTEX_NOT_CONFIGURED',
    errorMessage: 'No Vertex AI credential configured — add it in Settings → Credentials (Google Vertex AI) or the VERTEX_API_KEY env var first',
    // The model, length, size and audio flag are resolved against the catalog by videoGen/vertex.js.
    buildParams: (body, prepared) => ({
      modelId: body.vertexModelId,
      ...(prepared.lastImagePath ? { lastImagePath: prepared.lastImagePath } : {}),
      ...(prepared.referenceImagePaths?.length ? { referenceImagePaths: prepared.referenceImagePaths } : {}),
      ...(prepared.uploadedTempPaths?.length ? { uploadedTempPaths: prepared.uploadedTempPaths } : {}),
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio,
      width: body.width,
      height: body.height,
      duration: body.vertexDuration,
      ...(body.vertexResolution ? { resolution: body.vertexResolution } : {}),
      ...(body.vertexGenerateAudio === true ? { generateAudio: true } : {}),
      ...(body.vertexSeed != null ? { seed: body.vertexSeed } : {}),
    }),
  },
  [VIDEO_GEN_MODE.GEMINI]: {
    prepare: (settings) => ({ usable: isVideoModeUsable(settings, VIDEO_GEN_MODE.GEMINI), extras: {} }),
    stageInputs: stageCastReferenceImages,
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.GEMINI, params),
    errorCode: 'GEMINI_WEB_UNAVAILABLE',
    errorMessage: 'Gemini video renders in the PortOS Browser and is not available on this install',
    buildParams: (body, prepared) => ({
      modelId: GEMINI_OMNI_WEB_MODEL.id,
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio,
      width: body.width,
      height: body.height,
      ...(prepared.uploadedTempPaths?.length ? { uploadedTempPaths: prepared.uploadedTempPaths } : {}),
    }),
  },
  [VIDEO_GEN_MODE.REACTOR]: {
    prepare: (settings) => ({
      usable: isVideoModeUsable(settings, VIDEO_GEN_MODE.REACTOR),
      extras: {},
    }),
    stageInputs: NO_STAGED_INPUTS,
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.REACTOR, params),
    errorCode: 'REACTOR_NOT_CONFIGURED',
    errorMessage: 'No reactor.inc API key configured — set it in Settings → Video Gen (or the REACTOR_API_KEY env var) first',
    buildParams: (body) => ({
      continueFromClipId: body.reactorClipId,
      seconds: body.reactorSeconds,
      seed: body.reactorSeed,
      aspect: body.reactorAspect,
    }),
  },
};

/**
 * Retry validator for a persisted hosted video job, or null for a local job.
 * Hosted retries replay provider params the local model catalog knows nothing
 * about (a fal provider id, Reactor's seconds/seed), so they are validated by
 * the backend's own `validateRetry` and never by the local validator. Own-key
 * lookup: `params.mode` is persisted data, so `constructor`/`__proto__` must
 * not resolve to an inherited member.
 */
export const hostedVideoRetryValidator = (mode) => (
  typeof mode === 'string' && Object.hasOwn(HOSTED_VIDEO_SUBMISSIONS, mode)
    ? HOSTED_VIDEO_SUBMISSIONS[mode].validateRetry
    : null
);
