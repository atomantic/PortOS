import { getVideoModels, getDefaultVideoModelId } from '../../lib/mediaModels.js';
import { captureSystemCapabilities, detectSystemCapabilities, withHardwareCompatibility } from '../../lib/systemCapabilities.js';

// Queue admission and rendering must agree on a capability-dependent default.
// Explicit null remains an unknown model: routed jobs use it as a sentinel.
export async function resolveVideoModelSelection(modelId, {
  resolveModel = (id) => getVideoModels().find((entry) => entry.id === id) || null,
} = {}) {
  const omitted = modelId === undefined || modelId === '';
  let capabilities = captureSystemCapabilities();
  let selectedModelId = omitted ? getDefaultVideoModelId(capabilities) : modelId;
  let model = resolveModel(selectedModelId);
  const requirements = model?.hardwareRequirements;
  if (requirements?.requiresNvidiaGpu || requirements?.minVramGb != null
    || requirements?.minCudaComputeCapability != null) {
    capabilities = await detectSystemCapabilities();
    if (omitted) selectedModelId = getDefaultVideoModelId(capabilities);
    model = resolveModel(selectedModelId);
  }
  return {
    modelId: selectedModelId,
    model: model && withHardwareCompatibility(model, capabilities, model.hardwareRequirements),
  };
}
