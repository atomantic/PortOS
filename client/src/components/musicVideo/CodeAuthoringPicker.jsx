import { useEffect } from 'react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import { supportsToolFreeOneShot, toolFreeOneShotSelectionPolicy } from '../../utils/providerSelection.js';
import useProviderModels from '../../hooks/useProviderModels.js';

/** Explicit authoring pin, separate from the brief/lyrics provider (which may be a TUI). */
export default function CodeAuthoringPicker({ value, onChange, onValidityChange, disabled = false }) {
  const author = useProviderModels({ allowDefault: true, silent: true, withEffort: true, filter: Boolean });
  const current = value || { providerId: '', model: '', effort: '' };
  const { setSelectedProviderId, setSelectedModel } = author;
  useEffect(() => {
    setSelectedProviderId(current.providerId || '');
    setSelectedModel(current.model || '');
  }, [current.providerId, current.model, setSelectedProviderId, setSelectedModel]);
  const selected = author.providers.find((provider) => provider.id === current.providerId);
  const valid = !author.loading && supportsToolFreeOneShot(selected) && Boolean(current.providerId && current.model);
  useEffect(() => { onValidityChange?.(valid); }, [valid, onValidityChange]);
  const pickProvider = (providerId) => {
    const provider = author.providers.find((entry) => entry.id === providerId);
    // An explicit provider choice pins its configured model, never an unshown
    // active-provider fallback. A provider without a default needs a model pick.
    onChange({ providerId, model: provider?.defaultModel || '', effort: '' });
  };
  return <div className="min-w-0 space-y-1">
    <ProviderModelSelector
      providers={author.providers} selectedProviderId={current.providerId || ''}
      selectedModel={current.model || ''} availableModels={author.availableModels}
      onProviderChange={pickProvider} onModelChange={(model) => onChange({ ...current, model })}
      effort={current.effort || ''} onEffortChange={(effort) => onChange({ ...current, effort })}
      selectionPolicy={toolFreeOneShotSelectionPolicy} label="Code authoring provider" modelLabel="Code authoring model"
      emptyProviderOption="Choose an authoring provider" emptyModelOption="Choose an authoring model"
      includeDefaultModel disabled={disabled} loading={author.loading} compact alwaysShowModel
    />
    <p className="text-xs text-port-text-muted">Required for every media mode. Choose an API provider or a supported headless CLI that disables tools. TUI sessions cannot author composition documents. The server rechecks compatibility before generation.</p>
    {!author.loading && !valid && <p className="text-xs text-port-warning" role="status">Select an available code authoring provider and model before starting a run. Saved unavailable pins are retained until you replace them.</p>}
  </div>;
}
