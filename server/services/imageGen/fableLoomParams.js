import { ServerError } from '../../lib/errorHandler.js';
import { IMAGE_GEN_MODE } from '../../lib/generationModes.js';
import { asFableLoomRenderSettings, inspectEpisodeProductionOrder } from '../../lib/fableLoomProduction.js';
import { loraCompatKey } from '../../lib/runners.js';
import { getLoom } from '../fableLoom/records.js';
import { compileFableLoomVisualRequest, fableLoomImageCapabilities } from '../fableLoom/visualConditioning.js';
import { maxInputImages, resolveCloudProviderConfig } from './cloudProviderConfig.js';
import { selectLocalImageModelFromSettings } from './prepareParams.js';
import { applyImageVisualProfile, imageVisualProfileRevision } from './visualProfile.js';

const MAX_REFERENCE_IMAGES = 4;

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
  const cloud = selected ? null : resolveCloudProviderConfig(settings, mode, {
    model: params.cloudModel, modelIsShippedDefault: params.cloudModelIsShippedDefault,
  });
  const model = selected
    ? { ...selected, loraCompatKey: loraCompatKey(selected) }
    : (cloud ? { id: cloud.modelId } : null);
  const providerMode = params.mediaProviderPeerId ? 'federated' : mode;
  const compiled = await compileFableLoomVisualRequest({
    tag: params.fableLoom,
    visualProfileOverride: params.visualProfileOverride,
    kind: 'image',
    capability: fableLoomImageCapabilities({
      mode: providerMode,
      model,
      // The backend's own input cap (per model for fal.ai), never above
      // the form ceiling.
      inputBudget: Math.max(0, Math.min(maxInputImages(mode, cloud?.modelId) ?? MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGES) - (params.initImagePath ? 1 : 0)),
    }),
    authoredPrompt: params.prompt,
    authoredNegativePrompt: params.negativePrompt,
  });
  if (compiled) {
    // The compiler owns photography composition; snapshot its profile without
    // appending a second copy of the same clauses or additions.
    params.visualProfile = compiled.visualProfile;
    params.visualProfileRevision = imageVisualProfileRevision(compiled.visualProfile);
    params.prompt = compiled.prompt;
    params.negativePrompt = compiled.negativePrompt;
    // The compiler's canon blocks, listed beside what the scene's own request listed (#11317).
    if (compiled.promptAdditions?.length) params.promptAdditions = [...(params.promptAdditions || []), ...compiled.promptAdditions];
    params.referenceImagePaths = compiled.referenceImagePaths;
    params.referenceImageStrengths = compiled.referenceImageStrengths;
    params.loraFilenames = compiled.loraFilenames;
    params.loraPaths = [];
    params.loraScales = compiled.loraScales;
    params.visualConditioning = compiled.visualConditioning ? {
      ...compiled.visualConditioning,
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
  } else {
    // Legacy unlinked scenes have no canon compilation, but an explicit
    // request profile still owns its photography and optional finish.
    Object.assign(params, applyImageVisualProfile(params, params.visualProfileOverride));
  }
  return params;
}
