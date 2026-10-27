import { ServerError } from '../../lib/errorHandler.js';
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE } from '../../lib/generationModes.js';
import { asFableLoomRenderSettings, inspectEpisodeProductionOrder } from '../../lib/fableLoomProduction.js';
import { isFlux2, loraCompatKey, usesDiffusersRunner } from '../../lib/runners.js';
import { usesMossSwift } from '../../lib/imageRuntimeRemedies.js';
import { PATHS, sha256File } from '../../lib/fileUtils.js';
import { IMAGE_REFERENCE_REQUEST_LIMIT } from '../../lib/imageGenCapabilities.js';
import { sanitizeVisualConditioning } from '../../lib/fableLoomPlayback.js';
import { weaveLoraTriggers } from '../../lib/loraTriggers.js';
import { readTriggerWordsByFilename } from '../loras.js';
import { getLoom } from '../fableLoom/records.js';
import { compileFableLoomVisualRequest, fableLoomImageCapabilities } from '../fableLoom/visualConditioning.js';
import { maxInputImages, resolveCloudProviderConfig } from './cloudProviderConfig.js';
import { selectLocalImageModelFromSettings } from './prepareParams.js';
import { applyImageVisualProfile, imageVisualProfileRevision } from './visualProfile.js';
import { captureRequestImage } from '../fableLoom/requestInputs.js';

const MAX_REFERENCE_IMAGES = 4;
export const fableLoomMultipartUnsupported = () => new ServerError(
  'FableLoom scene renders accept gallery images, not file uploads. Upload the image to the gallery first.',
  { status: 400, code: 'FABLELOOM_MULTIPART_UNSUPPORTED' },
);

/** Read-only canon preparation after backend resolution, shared by preview and submit. */
export async function prepareFableLoomImageParams({ params, mode, settings }) {
  if (!params.fableLoom) return params;
  params.authoredPrompt = params.prompt || '';
  params.authoredNegativePrompt = params.negativePrompt || '';
  const taggedLoom = await getLoom(params.fableLoom.loomId);
  const taggedEpisode = taggedLoom?.episodes?.find((episode) => episode.id === params.fableLoom.episodeId);
  const renderSettings = taggedLoom ? asFableLoomRenderSettings(taggedLoom.renderSettings) : null;
  if (renderSettings) {
    params.width = renderSettings.width;
    params.height = renderSettings.height;
    params.aspectRatio = renderSettings.aspectRatio;
  }
  if (taggedLoom && taggedEpisode) {
    const episodeOrder = inspectEpisodeProductionOrder(taggedLoom, taggedEpisode);
    if (!episodeOrder.ready) {
      throw new ServerError(
        `FableLoom storyboard production is out of order: ${episodeOrder.reason}`,
        {
          status: 409,
          code: 'FABLELOOM_EPISODE_ORDER_BLOCKED',
          context: { details: { episodeOrder } },
        },
      );
    }
  }
  const selected = mode === IMAGE_GEN_MODE.LOCAL
    ? selectLocalImageModelFromSettings(settings, params.modelId)
    : null;
  if (selected && params.referenceImagePaths?.length
    && !isFlux2(selected) && !(usesDiffusersRunner(selected) && selected.pipelineClass === 'QwenImage21Pipeline')) {
    throw new ServerError('This local model cannot use the requested reference images.', { status: 400, code: 'FABLELOOM_REFERENCE_UNSUPPORTED' });
  }
  if (selected && params.initImagePath && (usesMossSwift(selected)
    || (process.platform === 'win32' && !isFlux2(selected) && !usesDiffusersRunner(selected)))) {
    throw new ServerError('This local runtime cannot use the requested init image. Choose a compatible model.', { status: 400, code: 'FABLELOOM_INIT_UNSUPPORTED' });
  }
  const cloud = selected ? null : resolveCloudProviderConfig(settings, mode, {
    model: params.cloudModel, modelIsShippedDefault: params.cloudModelIsShippedDefault,
  });
  const model = selected
    ? { ...selected, loraCompatKey: loraCompatKey(selected) }
    : (cloud ? { id: cloud.modelId } : null);
  const providerMode = params.mediaProviderPeerId ? 'federated' : mode;
  const inputBudget = Math.max(0, Math.min(maxInputImages(mode, cloud?.modelId) ?? MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGES) - (params.initImagePath ? 1 : 0));
  const capability = fableLoomImageCapabilities({ mode: providerMode, model, inputBudget });
  const compiled = await compileFableLoomVisualRequest({
    tag: params.fableLoom,
    visualProfileOverride: params.visualProfileOverride,
    kind: 'image',
    capability,
    authoredPrompt: params.prompt,
    authoredNegativePrompt: params.negativePrompt,
  });
  if (compiled) {
    const requestReferences = params.referenceImagePaths || [];
    const requestStrengths = params.referenceImageStrengths || [];
    const requestFilenames = params.loraFilenames || [];
    const requestPaths = params.loraPaths || [];
    const requestScales = params.loraScales || [];
    const requestAdapters = [...requestFilenames.map(name => join(PATHS.loras, name)), ...requestPaths];
    const canonAdapters = compiled.loraFilenames || [];
    const adapterCount = canonAdapters.length + requestAdapters.length;
    if (requestScales.length > requestAdapters.length) {
      throw new ServerError('Each requested LoRA scale needs a matching request adapter.', { status: 400, code: 'FABLELOOM_LORA_SCALE_MISMATCH' });
    }
    if (requestAdapters.length && !capability.supportsLora) {
      throw new ServerError('This FableLoom backend cannot use the requested LoRA adapters.', { status: 400, code: 'FABLELOOM_LORA_UNSUPPORTED' });
    }
    if (adapterCount > (capability.loraBudget ?? 8)) {
      throw new ServerError(`FableLoom accepts at most ${capability.loraBudget ?? 8} LoRA adapters including canon; received ${adapterCount}.`, { status: 400, code: 'FABLELOOM_LORA_BUDGET_EXCEEDED' });
    }
    const referenceCount = compiled.referenceImagePaths.length + requestReferences.length;
    const qwenEdit = selected?.pipelineClass === 'QwenImage21Pipeline';
    const providerInputLimit = qwenEdit ? 10 : maxInputImages(mode, cloud?.modelId);
    const referenceLimit = CLOUD_IMAGE_GEN_MODES.includes(mode)
      ? Math.min(providerInputLimit ?? IMAGE_REFERENCE_REQUEST_LIMIT, IMAGE_REFERENCE_REQUEST_LIMIT)
      : qwenEdit ? 10 : MAX_REFERENCE_IMAGES;
    if (referenceCount > referenceLimit || (providerInputLimit != null && referenceCount + (params.initImagePath ? 1 : 0) > providerInputLimit)) {
      throw new ServerError(`FableLoom canon and the request need ${referenceCount} reference images${params.initImagePath ? ' plus an init image' : ''}, exceeding this backend's limit. Remove a reference or choose another backend.`, { status: 400, code: 'FABLELOOM_INPUT_BUDGET_EXCEEDED' });
    }
    if (requestStrengths.some(strength => strength !== 1) && (providerMode !== IMAGE_GEN_MODE.LOCAL || selected?.runner !== 'flux2')) {
      throw new ServerError('This backend cannot apply per-reference strengths. Use full strength or choose FLUX.2.', { status: 400, code: 'FABLELOOM_REFERENCE_STRENGTH_UNSUPPORTED' });
    }
    // The quantized FLUX.2 LoRA route switches to bf16 without a KV model and
    // would otherwise discard every reference after the preview.
    if (selected?.runner === 'flux2' && (selected.quantization || 'sdnq') !== 'none' && adapterCount && referenceCount) {
      throw new ServerError('This quantized FLUX.2 model cannot use LoRAs and reference images together. Choose a compatible model or remove one input.', { status: 400, code: 'FABLELOOM_INPUTS_INCOMPATIBLE' });
    }
    const loraRoot = `${resolve(PATHS.loras)}${sep}`;
    if (requestAdapters.some(path => !resolve(path).startsWith(loraRoot) || !existsSync(resolve(path)))) {
      throw new ServerError('A requested LoRA is unavailable in the local LoRA directory.', { status: 400, code: 'FABLELOOM_LORA_NOT_FOUND' });
    }
    const canonPaths = new Set(canonAdapters.map(name => resolve(PATHS.loras, name)));
    if (requestAdapters.some(path => canonPaths.has(resolve(path)))) {
      throw new ServerError('A requested LoRA is already selected by scene canon. Remove the duplicate request adapter.', { status: 400, code: 'FABLELOOM_LORA_DUPLICATE' });
    }
    const requestDigests = await Promise.all(requestAdapters.map(path => sha256File(resolve(path)).catch(() => null)));
    if (requestDigests.some(digest => !digest)) {
      throw new ServerError('A requested LoRA could not be fingerprinted for FableLoom provenance.', { status: 400, code: 'FABLELOOM_LORA_UNREADABLE' });
    }
    const allReferences = [...compiled.referenceImagePaths, ...requestReferences];
    const allStrengths = [...compiled.referenceImageStrengths, ...requestReferences.map((_, index) => requestStrengths[index] ?? 1)];
    const allScales = [...canonAdapters.map((_, index) => compiled.loraScales[index] ?? 1), ...requestAdapters.map((_, index) => requestScales[index] ?? 1)];
    const requestAssets = await Promise.all(requestReferences.map(path => captureRequestImage(path, 'request-reference')));
    if (params.initImagePath) requestAssets.push(await captureRequestImage(params.initImagePath, 'request-init', params.initImageStrength));
    const adapterNames = [...canonAdapters, ...requestFilenames, ...requestPaths];
    const triggerWords = mode === IMAGE_GEN_MODE.LOCAL ? await readTriggerWordsByFilename(adapterNames) : null;
    const renderedPrompt = triggerWords
      ? weaveLoraTriggers(compiled.prompt, adapterNames.map(name => triggerWords[basename(name)])).prompt : null;
    // The compiler owns photography composition; snapshot its profile without
    // appending a second copy of the same clauses or additions.
    params.visualProfile = compiled.visualProfile;
    params.visualProfileRevision = imageVisualProfileRevision(compiled.visualProfile);
    params.prompt = compiled.prompt;
    params.negativePrompt = compiled.negativePrompt;
    // The compiler's canon blocks, listed beside what the scene's own request listed (#11317).
    if (compiled.promptAdditions?.length) params.promptAdditions = [...(params.promptAdditions || []), ...compiled.promptAdditions];
    params.referenceImagePaths = allReferences;
    params.referenceImageStrengths = allStrengths;
    params.loraFilenames = [...canonAdapters, ...requestFilenames];
    params.loraPaths = requestPaths;
    params.loraScales = allScales;
    params.visualConditioning = compiled.visualConditioning ? {
      ...compiled.visualConditioning,
      authoredPrompt: params.authoredPrompt,
      authoredNegativePrompt: params.authoredNegativePrompt,
      ...(renderedPrompt !== null ? { renderedPrompt } : {}),
      ...(params.visualProfileOverride !== undefined ? { visualProfileOverride: params.visualProfileOverride } : {}),
      assets: [...compiled.visualConditioning.assets, ...requestAssets],
      adapters: [
        ...compiled.visualConditioning.adapters.map(adapter => ({ ...adapter, source: 'Canon adapter' })),
        ...requestAdapters.map((path, index) => ({ filename: basename(path), scale: requestScales[index] ?? 1, characterId: null, sha256: requestDigests[index], source: 'Request adapter', relativePath: relative(PATHS.loras, resolve(path)).split(sep).join('/') })),
      ],
      referenceImageStrengths: allStrengths,
      render: {
        provider: providerMode,
        modelId: model?.id || null,
        modelRevision: model?.revision || null,
        parameters: {
          width: params.width,
          height: params.height,
          ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
        },
      },
    } : null;
    if (params.visualConditioning && !sanitizeVisualConditioning(params.visualConditioning)) {
      throw new ServerError('These FableLoom inputs cannot be preserved for exact replay. Check image filenames and adapter paths and scales.', {
        status: 400, code: 'FABLELOOM_PROVENANCE_UNAVAILABLE',
      });
    }
  } else {
    // Legacy unlinked scenes have no canon compilation, but an explicit
    // request profile still owns its photography and optional finish.
    Object.assign(params, applyImageVisualProfile(params, params.visualProfileOverride));
  }
  return params;
}
