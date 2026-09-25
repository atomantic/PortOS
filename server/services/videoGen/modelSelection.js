import { getVideoModels, getDefaultVideoModelId } from '../../lib/mediaModels.js';
import { captureSystemCapabilities, detectSystemCapabilities, withHardwareCompatibility } from '../../lib/systemCapabilities.js';
import { getSettings } from '../settings.js';

// Queue admission and rendering must agree on a capability-dependent default.
// Explicit null remains an unknown model: routed jobs use it as a sentinel.
export async function resolveVideoModelSelection(modelId, {
  resolveModel = (id) => getVideoModels().find((entry) => entry.id === id) || null,
} = {}) {
  const omitted = modelId === undefined || modelId === '';
  const settings = omitted ? await getSettings() : null;
  const preferredId = settings?.videoGen?.defaultModelId;
  let capabilities = captureSystemCapabilities();
  let selectedModelId = omitted ? getDefaultVideoModelId(capabilities, preferredId) : modelId;
  let model = resolveModel(selectedModelId);
  const requirements = model?.hardwareRequirements;
  if (requirements?.requiresNvidiaGpu || requirements?.minVramGb != null
    || requirements?.minCudaComputeCapability != null) {
    capabilities = await detectSystemCapabilities();
    if (omitted) selectedModelId = getDefaultVideoModelId(capabilities, preferredId);
    model = resolveModel(selectedModelId);
  }
  return {
    modelId: selectedModelId,
    model: model && withHardwareCompatibility(model, capabilities, model.hardwareRequirements),
  };
}
