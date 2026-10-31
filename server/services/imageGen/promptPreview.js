/**
 * Compose-time preview of what an Image Gen render sends to its model (#11317):
 * the same request preparation and the same per-backend prompt builders the
 * render runs, without staging uploads or queueing anything. Uploads the form
 * holds are named by `previewUploadLabel` in place of their staged path, and
 * the grok/agy output path names the job folder it will get.
 */
import { basename, join } from 'node:path';
import { fableLoomMultipartUnsupported, prepareFableLoomImageParams } from './fableLoomParams.js';
import { tmpdir } from 'node:os';
import { getRunwayImageModel, RUNWAY_IMAGE_DEFAULT_MODEL } from '../../lib/runwayImageModels.js';
import { IMAGE_GEN_MODE } from '../../lib/generationModes.js';
import { carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';
import { FAL_IMAGE_DEFAULT_MODEL, falImageFamily } from '../../lib/falImageModels.js';
import { maxInputImages, resolveCloudProviderConfig } from './cloudProviderConfig.js';
import { resolveInputImages } from './inputImages.js';
import { reviewedReferencePreview } from './reviewedReference.js';
import { ServerError } from '../../lib/errorHandler.js';
import { prepareGenerateParams, quickEditCompositionDigest, previewUploadLabel, resolveLocalImageModel, selectLocalImageModelFromSettings } from './prepareParams.js';
import { codexSentPrompt } from './codex.js';
import { grokSentPrompt } from './grok.js';
import { agySentPrompt } from './agy.js';
import { falImageSentPrompt } from './fal.js';
import { runwayImageSentPrompt } from './runway.js';
import { localSentPrompt } from './local.js';

const isUploadLabel = (path) => typeof path === 'string' && path.startsWith('(uploaded image ');

// The input images in the order the render attaches them: gallery images
// resolved as the backend resolves them, the form's uploads by label.
function previewInputImages(mode, params, modelId) {
  const init = params.initImagePath || null;
  const refs = params.referenceImagePaths || [];
  const named = resolveInputImages({
    mode, modelId,
    initImagePath: isUploadLabel(init) ? null : init,
    referenceImagePaths: refs.filter((path) => !isUploadLabel(path)),
  });
  const initPath = isUploadLabel(init) ? init : named.initPath;
  const ordered = [...(initPath ? [initPath] : []), ...named.referencePaths, ...refs.filter(isUploadLabel)];
  const paths = ordered.slice(0, maxInputImages(mode, modelId) ?? ordered.length);
  return { paths, initPath, referencePaths: initPath ? paths.slice(1) : paths };
}

const jobOutputPath = (prefix) => join(tmpdir(), `${prefix}-<job>`, 'output.png');

export async function previewImagePrompt({ uploadedInitImage = false, uploadedReferenceCount = 0, reviewReference = false, ...body }) {
  if (body.fableLoom && (uploadedInitImage || uploadedReferenceCount)) throw fableLoomMultipartUnsupported();
  const referenceImageFields = Array.from({ length: uploadedReferenceCount }, (_, index) => `referenceImage${index + 1}`);
  const files = {
    ...(uploadedInitImage ? { initImage: {} } : {}),
    ...Object.fromEntries(referenceImageFields.map((field) => [field, {}])),
  };
  const { data: params, mode, settings } = await prepareGenerateParams({ data: body, files, referenceImageFields, preview: true });
  await prepareFableLoomImageParams({ params, mode, settings });
  const showsReferenceStrengths = params.fableLoom && mode === IMAGE_GEN_MODE.LOCAL && !params.mediaProviderPeerId
    && selectLocalImageModelFromSettings(settings, params.modelId)?.runner === 'flux2';
  if (reviewReference && (params.initImagePath || !params.referenceImagePaths?.length || (!params.quickEdit && params.referenceImagePaths.length !== 1) || uploadedInitImage || uploadedReferenceCount || (!params.mediaProviderPeerId && mode === IMAGE_GEN_MODE.EXTERNAL))) {
    throw new ServerError('Review requires named reference images, the edited image first', { status: 400, code: 'REVIEWED_REFERENCE_UNSUPPORTED' });
  }
  const envelope = {
    mode,
    ...(params.quickEdit ? {
      reviewedPromptDigest: await quickEditCompositionDigest({ params, mode, settings }),
      referenceImages: (params.referenceImagePaths || []).map((path, index) => ({ filename: basename(path), status: 'included', source: `Input image ${index + 1} · ${index ? 'Visual reference' : 'Image to edit'}` })),
    } : {}),
    ...(reviewReference ? await reviewedReferencePreview(params.referenceImagePaths[0]) : {}),
    ...(params.fableLoom ? {
      authoredPrompt: params.authoredPrompt,
      authoredNegativePrompt: params.authoredNegativePrompt,
      referenceImages: [
        ...(params.initImagePath ? [{ filename: basename(params.initImagePath), status: 'included', source: 'Init image' }] : []),
        ...(params.referenceImagePaths || []).map((path, index) => ({
          filename: basename(path), status: 'included',
          source: params.visualConditioning?.assets[index]?.role === 'request-reference'
            ? 'Request reference' : params.visualConditioning?.assets[index]?.role || 'Scene reference',
          ...(showsReferenceStrengths ? { strength: params.referenceImageStrengths?.[index] ?? 1 } : {}),
        })),
      ],
      ...((params.visualConditioning?.adapters?.length) ? {
        loraAdapters: params.visualConditioning.adapters.map(({ filename, scale, source }) => ({ filename, scale, source: source || 'Canon adapter' })),
      } : {}),
    } : {}),
  };
  return params.quickEdit ? previewQuickImageEdit({ params, mode, settings, envelope }) : previewPreparedImagePrompt({ params, mode, settings, envelope });
}

/** Apply the render backend's prompt builder to an already-prepared request. */
export async function previewPreparedImagePrompt({ params, mode = params.mode, settings, envelope = {} }) {
  const carried = carriedPromptAdditions(params);
  const common = {
    prompt: params.prompt || '', negativePrompt: params.negativePrompt || '',
    width: params.width, height: params.height, initImageStrength: params.initImageStrength,
    promptAdditions: carried,
  };
  const cloud = params.mediaProviderPeerId ? null : resolveCloudProviderConfig(settings, mode, { model: params.cloudModel || params.model });
  // The same refusal POST /generate gives a disabled provider, text-to-image included.
  if (cloud && !cloud.enabled) throw cloud.disabledError;

  if (params.mediaProviderPeerId) {
    return { ...envelope, remote: true, ...sentPromptRecord({ sentPrompt: common.prompt, sentNegativePrompt: common.negativePrompt, carried }) };
  }

  if (mode === IMAGE_GEN_MODE.CODEX) {
    return { ...envelope, ...codexSentPrompt({ ...common, inputImages: previewInputImages(mode, params) }).record };
  }
  if (mode === IMAGE_GEN_MODE.GROK) {
    return { ...envelope, ...grokSentPrompt({
      ...common, aspectRatio: params.aspectRatio ?? cloud?.providerParams.aspectRatio, stagingPath: jobOutputPath('portos-grok'),
      inputImages: previewInputImages(mode, params),
    }).record };
  }
  if (mode === IMAGE_GEN_MODE.AGY) {
    return { ...envelope, ...agySentPrompt({ ...common, stagingPath: jobOutputPath('portos-agy'), inputImages: previewInputImages(mode, params) }).record };
  }
  if (mode === IMAGE_GEN_MODE.RUNWAY) {
    return { ...envelope, ...runwayImageSentPrompt({ ...common, modelId: cloud?.providerParams.model, inputImages: previewInputImages(mode, params, cloud?.providerParams.model), visualConditioning: params.visualConditioning }).record };
  }
  if (mode === IMAGE_GEN_MODE.FAL) {
    const family = falImageFamily(cloud?.providerParams.model || FAL_IMAGE_DEFAULT_MODEL) || falImageFamily(FAL_IMAGE_DEFAULT_MODEL);
    return { ...envelope, ...falImageSentPrompt({ ...common, family, inputImages: previewInputImages(mode, params, family.textEndpoint) }).record };
  }
  if (mode === IMAGE_GEN_MODE.LOCAL && !params.mediaProviderPeerId) {
    const { selectedModel } = resolveLocalImageModel(settings, params);
    return { ...envelope, ...await localSentPrompt({ ...params, ...common, model: selectedModel, modelId: selectedModel?.id || params.modelId }) };
  }
  // The SD-API backend and a federated provider receive the prompt and negative
  // as written; a provider machine's own backend may add its own lines there.
  return {
    ...envelope,
    ...(params.mediaProviderPeerId ? { remote: true } : {}),
    ...sentPromptRecord({ sentPrompt: common.prompt, sentNegativePrompt: common.negativePrompt, carried }),
  };
}

/** Quick edits validate the complete composed text before queue admission as well as preview. */
export async function previewQuickImageEdit(context) {
  const record = await previewPreparedImagePrompt(context);
  const { params, mode, settings } = context;
  const cloud = mode === IMAGE_GEN_MODE.RUNWAY && !params.mediaProviderPeerId
    ? resolveCloudProviderConfig(settings, mode, { model: params.cloudModel || params.model }) : null;
  const limit = cloud ? getRunwayImageModel(cloud.providerParams.model || RUNWAY_IMAGE_DEFAULT_MODEL)?.promptMaxChars ?? 32000 : 32000;
  if (record.sentPrompt.length > limit) {
    throw new ServerError(`Complete edit prompt is ${record.sentPrompt.length}/${limit} characters. Shorten your instruction; nothing was submitted or truncated.`, { status: 400, code: 'IMAGE_PROMPT_TOO_LONG' });
  }
  return record;
}
