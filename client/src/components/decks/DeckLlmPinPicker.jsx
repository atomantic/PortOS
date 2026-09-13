import { useEffect, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector';
import useProviderModels from '../../hooks/useProviderModels';

/**
 * Provider / model / effort pin for the deck's text-LLM jobs (casting + prompt
 * writing). The persisted pin is the source of truth: it is mirrored into the
 * picker whenever it changes (a refetched deck, another surface's edit), and
 * every user change is lifted as `{ providerId, model, effort }` — an empty
 * provider means "the active provider", matching the server's fallback.
 */
export default function DeckLlmPinPicker({ pin, onChange, label = 'Prompt model', disabled = false }) {
  const {
    providers, selectedProviderId, selectedModel, availableModels,
    setSelectedProviderId, setSelectedModel, loading,
  } = useProviderModels({ allowDefault: true, withEffort: true, silent: true });
  const [effort, setEffort] = useState(pin?.effort || '');

  const pinProvider = pin?.providerId || '';
  const pinModel = pin?.model || '';
  const pinEffort = pin?.effort || '';
  useEffect(() => {
    if (loading) return;
    setSelectedProviderId(providers.some((p) => p.id === pinProvider) ? pinProvider : '');
    setSelectedModel(pinModel);
    setEffort(pinEffort);
  }, [loading, providers, pinProvider, pinModel, pinEffort, setSelectedProviderId, setSelectedModel]);

  const emit = (next) => onChange?.({
    providerId: next.providerId ?? selectedProviderId,
    model: next.model ?? selectedModel,
    effort: next.effort ?? effort,
  });

  return (
    <ProviderModelSelector
      providers={providers}
      selectedProviderId={selectedProviderId}
      selectedModel={selectedModel}
      availableModels={availableModels}
      onProviderChange={(id) => { setSelectedProviderId(id); emit({ providerId: id, model: '' }); }}
      onModelChange={(m) => { setSelectedModel(m); emit({ model: m }); }}
      effort={effort}
      onEffortChange={(e) => { setEffort(e); emit({ effort: e }); }}
      emptyProviderOption="Active provider"
      emptyModelOption="Default model"
      alwaysShowModel
      compact
      label={label}
      loading={loading}
      disabled={disabled}
    />
  );
}
