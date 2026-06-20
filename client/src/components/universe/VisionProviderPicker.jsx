/**
 * Self-contained vision provider/model picker.
 *
 * Owns a `useProviderModels` instance scoped to enabled API providers, with
 * LOCAL backends (Ollama / LM Studio) restricted to vision-capable models (cloud
 * providers' lists are left intact). Renders the provider+model dropdowns plus
 * the "no vision model" / "no provider" guidance, and lifts the current
 * selection to the parent via `onChange` so the caller can submit the chosen
 * `{ providerId, model }` and gate its action on a vision model being present.
 *
 * Extracted so the vision-describe modal and the universe refine form share ONE
 * picker (identical filter + messaging) instead of two copies that can drift —
 * and so a caller that only mounts it conditionally (the refine form, when a
 * style-reference image is attached) doesn't pay for the provider fetch until
 * it's actually needed.
 */

import { useEffect } from 'react';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import { enabledApiProviderFilter, visionLocalModelFilter } from '../../utils/providers';

export default function VisionProviderPicker({ label = 'Vision provider', onChange }) {
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading,
  } = useProviderModels({ filter: enabledApiProviderFilter, modelFilter: visionLocalModelFilter, silent: true });

  const hasProviders = providers.length > 0;
  // A provider is selected but exposes no vision-capable model (all of a local
  // backend's models were filtered out) — block the run with an explanation.
  const noVisionModel = hasProviders && !selectedModel;

  // Lift the selection so the caller can submit it and gate on a vision model.
  // `onChange` should be a stable setter; deps are bounded (load + user picks).
  useEffect(() => {
    onChange?.({ providerId: selectedProviderId, model: selectedModel, hasProviders, noVisionModel, loading });
  }, [onChange, selectedProviderId, selectedModel, hasProviders, noVisionModel, loading]);

  if (!hasProviders) {
    return (
      <p className="text-xs text-port-warning">
        {loading
          ? 'Loading providers…'
          : 'No API provider with a vision-capable model configured. Add one under Settings → Providers to analyze images.'}
      </p>
    );
  }

  return (
    <>
      <ProviderModelSelector
        providers={providers}
        selectedProviderId={selectedProviderId}
        selectedModel={selectedModel}
        availableModels={availableModels}
        onProviderChange={setSelectedProviderId}
        onModelChange={setSelectedModel}
        label={label}
        layout="row"
      />
      {noVisionModel ? (
        <p className="text-xs text-port-warning">
          This provider has no vision-capable model installed. Pick another provider, or install a
          vision model (e.g. a qwen-vl or llava model) to analyze images.
        </p>
      ) : null}
    </>
  );
}
