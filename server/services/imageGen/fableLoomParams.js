import { ServerError } from '../../lib/errorHandler.js';
import { existsSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { IMAGE_GEN_MODE } from '../../lib/generationModes.js';
import { asFableLoomRenderSettings, inspectEpisodeProductionOrder } from '../../lib/fableLoomProduction.js';
import { isFlux2, loraCompatKey, usesDiffusersRunner } from '../../lib/runners.js';
import { usesMossSwift } from '../../lib/imageRuntimeRemedies.js';
import { PATHS, sha256File } from '../../lib/fileUtils.js';
import { assertFlux2InputsCompatible } from '../../lib/flux2Inputs.js';
import { sanitizeVisualConditioning } from '../../lib/fableLoomPlayback.js';
import { weaveLoraTriggers } from '../../lib/loraTriggers.js';
import { readTriggerWordsByFilename } from '../loras.js';
import { getLoom } from '../fableLoom/records.js';
import { compileFableLoomVisualRequest, fableLoomImageCapabilities } from '../fableLoom/visualConditioning.js';
import { resolveCloudProviderConfig } from './cloudProviderConfig.js';
import { inputImageCap, localModelSupportsReferences, referenceImageCap, selectLocalImageModelFromSettings } from './prepareParams.js';
import { applyImageVisualProfile, imageVisualProfileRevision } from './visualProfile.js';
import { captureCanonImages, captureRequestImage } from '../fableLoom/requestInputs.js';

const DEFAULT_CANON_REFERENCE_BUDGET = 4;
export const fableLoomMultipartUnsupported = () => new ServerError(
  'FableLoom scene renders accept gallery images, not file uploads. Upload the image to the gallery first.',
  { status: 400, code: 'FABLELOOM_MULTIPART_UNSUPPORTED' },
);

async function prepareFableLoomScene(params) {
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
}

function resolveFableLoomBackend(params, mode, settings) {
  const peerRouted = Boolean(params.mediaProviderPeerId);
  const selected = !peerRouted && mode === IMAGE_GEN_MODE.LOCAL
    ? selectLocalImageModelFromSettings(settings, params.modelId)
    : null;
  if (selected && params.referenceImagePaths?.length
    && !localModelSupportsReferences(selected)) {
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
  const providerMode = peerRouted ? 'federated' : mode;
  const referenceLimit = referenceImageCap({ peerRouted, mode, localModel: selected, fableLoom: true, cloudModel: cloud?.modelId });
  const inputLimit = inputImageCap({ peerRouted, mode, localModel: selected, cloudModel: cloud?.modelId });
  const initCount = Number(Boolean(params.initImagePath));
  // Keep cloud canon selection stable for replay. Local canon can use the
  // selected runner's expanded capacity, subject to any combined input cap.
  const canonLimit = selected ? referenceLimit : Math.min(DEFAULT_CANON_REFERENCE_BUDGET, referenceLimit);
  const inputBudget = Math.max(0, Math.min(canonLimit, inputLimit ?? canonLimit) - initCount);
  const capability = fableLoomImageCapabilities({ mode: providerMode, model, inputBudget });
  return { selected, model, providerMode, referenceLimit, inputLimit, initCount, capability };
}

function validateFableLoomAdapters(params, compiled, capability) {
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
  return { requestFilenames, requestPaths, requestScales, requestAdapters, canonAdapters, adapterCount };
}

async function captureFableLoomAdapters(compiled, { requestFilenames, requestPaths, requestScales, requestAdapters, canonAdapters }) {
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
  const allScales = [...canonAdapters.map((_, index) => compiled.loraScales[index] ?? 1), ...requestAdapters.map((_, index) => requestScales[index] ?? 1)];
  return {
    filenames: [...canonAdapters, ...requestFilenames],
    paths: requestPaths,
    scales: allScales,
    provenance: requestAdapters.map((path, index) => ({
      filename: basename(path),
      scale: requestScales[index] ?? 1,
      characterId: null,
      sha256: requestDigests[index],
      source: 'Request adapter',
      relativePath: relative(PATHS.loras, resolve(path)).split(sep).join('/'),
    })),
  };
}

function validateFableLoomBackendInputs(params, compiled, { selected, providerMode, referenceLimit, inputLimit, initCount }, adapterCount) {
  const requestReferences = params.referenceImagePaths || [];
  const requestStrengths = params.referenceImageStrengths || [];
  const referenceCount = compiled.referenceImagePaths.length + requestReferences.length;
  if (referenceCount > referenceLimit || (inputLimit != null && referenceCount + initCount > inputLimit)) {
    throw new ServerError(`FableLoom canon and the request need ${referenceCount} reference images${params.initImagePath ? ' plus an init image' : ''}, exceeding this backend's limit. Remove a reference or choose another backend.`, { status: 400, code: 'FABLELOOM_INPUT_BUDGET_EXCEEDED' });
  }
  if (requestStrengths.some(strength => strength !== 1) && (providerMode !== IMAGE_GEN_MODE.LOCAL || !isFlux2(selected))) {
    throw new ServerError('This backend cannot apply per-reference strengths. Use full strength or choose FLUX.2.', { status: 400, code: 'FABLELOOM_REFERENCE_STRENGTH_UNSUPPORTED' });
  }
  try {
    // This phase checks the merged LoRA/reference set. Init-image compatibility
    // is validated by the normal local request and dispatch boundaries.
    assertFlux2InputsCompatible(selected, { referenceCount, loraCount: adapterCount });
  } catch (error) {
    if (error.code !== 'IMAGE_GEN_FLUX2_INPUTS_INCOMPATIBLE') throw error;
    throw new ServerError(error.message, { status: 400, code: 'FABLELOOM_INPUTS_INCOMPATIBLE' });
  }
}

async function buildFableLoomVisualConditioning(params, compiled, adapters, { providerMode, model }) {
  const requestReferences = params.referenceImagePaths || [];
  const requestStrengths = params.referenceImageStrengths || [];
  const allReferences = [...compiled.referenceImagePaths, ...requestReferences];
  const allStrengths = [...compiled.referenceImageStrengths, ...requestReferences.map((_, index) => requestStrengths[index] ?? 1)];
  // Canon images are resolved by name now but read at dispatch; their bytes are the evidence.
  const canonAssets = compiled.visualConditioning
    ? await captureCanonImages(compiled.visualConditioning.assets, compiled.referenceImagePaths) : [];
  const requestAssets = await Promise.all(requestReferences.map(path => captureRequestImage(path, 'request-reference')));
  if (params.initImagePath) requestAssets.push(await captureRequestImage(params.initImagePath, 'request-init', params.initImageStrength));
  const adapterNames = [...adapters.filenames, ...adapters.paths];
  const triggerWords = providerMode === IMAGE_GEN_MODE.LOCAL ? await readTriggerWordsByFilename(adapterNames) : null;
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
  params.loraFilenames = adapters.filenames;
  params.loraPaths = adapters.paths;
  params.loraScales = adapters.scales;
  params.visualConditioning = compiled.visualConditioning ? {
    ...compiled.visualConditioning,
    authoredPrompt: params.authoredPrompt,
    authoredNegativePrompt: params.authoredNegativePrompt,
    ...(renderedPrompt !== null ? { renderedPrompt } : {}),
    ...(params.visualProfileOverride !== undefined ? { visualProfileOverride: params.visualProfileOverride } : {}),
    assets: [...canonAssets, ...requestAssets],
    adapters: [
      ...compiled.visualConditioning.adapters.map(adapter => ({ ...adapter, source: 'Canon adapter' })),
      ...adapters.provenance,
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
}

/** Read-only canon preparation after backend resolution, shared by preview and submit. */
export async function prepareFableLoomImageParams({ params, mode, settings }) {
  if (!params.fableLoom) return params;
  params.authoredPrompt = params.prompt || '';
  params.authoredNegativePrompt = params.negativePrompt || '';
  await prepareFableLoomScene(params);
  const backend = resolveFableLoomBackend(params, mode, settings);
  const compiled = await compileFableLoomVisualRequest({
    tag: params.fableLoom,
    visualProfileOverride: params.visualProfileOverride,
    kind: 'image',
    capability: backend.capability,
    authoredPrompt: params.prompt,
    authoredNegativePrompt: params.negativePrompt,
  });
  if (compiled) {
    const adapterInputs = validateFableLoomAdapters(params, compiled, backend.capability);
    validateFableLoomBackendInputs(params, compiled, backend, adapterInputs.adapterCount);
    const adapters = await captureFableLoomAdapters(compiled, adapterInputs);
    await buildFableLoomVisualConditioning(params, compiled, adapters, backend);
  } else {
    // Legacy unlinked scenes still use the request's own photography and finish.
    Object.assign(params, applyImageVisualProfile(params, params.visualProfileOverride));
  }
  return params;
}
