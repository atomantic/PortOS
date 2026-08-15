/**
 * Self-contained vision provider/model picker.
 *
 * Owns a `useProviderModels` instance scoped to enabled API providers, with
 * LOCAL backends (Ollama / LM Studio) restricted to vision-capable models (cloud
 * providers' lists are left intact) — by the client id regex UNIONED with the
 * server's authoritative per-provider VLM set (`useVisionModelIds`), like every
 * other vision picker. Renders the provider+model dropdowns plus
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

import { useCallback, useEffect } from 'react';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';
import useVisionModelIds from '../../hooks/useVisionModelIds';
import { enabledApiProviderFilter, localBackendForProvider, visionLocalModelFilter } from '../../utils/providers';

export default function VisionProviderPicker({ label = 'Vision provider', onChange }) {
  // The server's authoritative per-provider VLM set, unioned into the filter:
  // the client id regex only knows the multimodal families it was written
  // against, so on its own it hides installed VLMs from newer ones (`gemma4`).
  // Every mount of this picker is behind a modal/conditional render, so the
  // capability scan is already deferred until it's needed — no `enabled` gate.
  const { idsByProvider: visionIds, loaded: visionLoaded } = useVisionModelIds();
  const modelFilter = useCallback(
    (id, provider) => visionLocalModelFilter(id, provider, visionIds),
    [visionIds],
  );

  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading,
  } = useProviderModels({ filter: enabledApiProviderFilter, modelFilter, silent: true });

  const hasProviders = providers.length > 0;
  // While the capability scan is in flight the filter is regex-only, so an empty
  // selection on a LOCAL backend is "don't know yet", not "none installed" —
  // asserting the blocker here would flash it and then flip. Cloud providers are
  // never filtered, so their empty selection is already a final answer.
  const visionPending = !visionLoaded
    && !!localBackendForProvider(providers.find((p) => p.id === selectedProviderId));
  // A provider is selected but exposes no vision-capable model (all of a local
  // backend's models were filtered out) — block the run with an explanation.
  const noVisionModel = hasProviders && !selectedModel && !visionPending;

  // Lift the selection so the caller can submit it and gate on a vision model.
  // `onChange` should be a stable setter; deps are bounded (load + user picks).
  // `loading` covers the capability scan too — the auto-picked model can still
  // change when it lands, so the selection isn't final until it settles.
  const resolving = loading || visionPending;
  useEffect(() => {
    onChange?.({ providerId: selectedProviderId, model: selectedModel, hasProviders, noVisionModel, loading: resolving });
  }, [onChange, selectedProviderId, selectedModel, hasProviders, noVisionModel, resolving]);

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
