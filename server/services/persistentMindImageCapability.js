/** Resolve whether the pinned Persistent Mind provider/model can consume images. */

import { isVisionCapableCliProvider, isVisionModel } from '../lib/localModelHeuristics.js';
import { listModels } from './localLlm.js';
import * as ollamaManager from './ollamaManager.js';

export const PERSISTENT_MIND_IMAGE_CAPABILITY = Object.freeze({
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported',
  UNKNOWN: 'unknown',
});

const result = (status, reason) => ({
  status,
  reason,
  settingsPath: '/settings?tab=ai-providers',
});

const localBackend = (provider) => {
  if (provider?.id === 'ollama') return 'ollama';
  if (provider?.id === 'lmstudio') return 'lmstudio';
  return null;
};

const modelId = (model) => (typeof model === 'string' ? model.trim() : '');

export function imageCapabilityAllowsAttempt(capability, provider) {
  return capability?.status === PERSISTENT_MIND_IMAGE_CAPABILITY.SUPPORTED
    || (capability?.status === PERSISTENT_MIND_IMAGE_CAPABILITY.UNKNOWN && provider?.type === 'api');
}

export async function resolvePersistentMindImageCapability(
  { provider, model },
  { listBackendModels = listModels, getOllamaCapabilities = ollamaManager.getModelCapabilities } = {},
) {
  if (!provider) return result('unsupported', 'Choose a Persistent Mind provider before attaching images.');
  if (provider.type === 'tui') {
    return result('unsupported', 'Interactive TUI providers cannot receive Persistent Mind image attachments.');
  }
  if (provider.type === 'cli') {
    return isVisionCapableCliProvider(provider)
      ? result('supported', 'This headless CLI accepts image attachments through its normal run lifecycle.')
      : result('unsupported', 'This headless CLI cannot receive Persistent Mind image attachments. Choose Codex, Claude Code, or a vision API provider.');
  }
  if (provider.type !== 'api') return result('unsupported', 'This provider transport cannot receive image attachments.');

  const selectedModel = modelId(model || provider.defaultModel);
  if (!selectedModel) return result('unknown', 'The API provider has no pinned model to verify for image support.');
  const backend = localBackend(provider);
  if (backend) {
    const models = await listBackendModels(backend).catch(() => null);
    if (!models) return result('unknown', `PortOS could not read the ${backend} model inventory to verify image support.`);
    const card = models.find((entry) => (entry?.id || entry?.name) === selectedModel);
    if (!card) return result('unknown', `The pinned model is not present in the ${backend} inventory.`);
    if (backend === 'ollama') {
      const capabilities = await getOllamaCapabilities(selectedModel).catch(() => null);
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        return result('unknown', 'Ollama did not report capabilities for the pinned model.');
      }
      return isVisionModel({ id: selectedModel, capabilities })
        ? result('supported', 'Ollama reports vision support for the pinned model.')
        : result('unsupported', 'Ollama reports that the pinned model is text-only.');
    }
    return isVisionModel(card)
      ? result('supported', 'LM Studio reports the pinned model as vision-capable.')
      : result('unsupported', 'LM Studio reports the pinned model as text-only.');
  }

  const declared = (Array.isArray(provider.models) ? provider.models : [])
    .find((entry) => (typeof entry === 'string' ? entry : entry?.id || entry?.name) === selectedModel);
  if (declared && typeof declared === 'object' && (declared.type || Array.isArray(declared.capabilities))) {
    return isVisionModel(declared)
      ? result('supported', 'The provider catalog reports vision support for the pinned model.')
      : result('unsupported', 'The provider catalog reports that the pinned model is text-only.');
  }
  return isVisionModel(selectedModel)
    ? result('supported', 'The pinned API model is a known vision model family.')
    : result('unknown', 'The API provider does not expose authoritative image-capability metadata for this model.');
}
