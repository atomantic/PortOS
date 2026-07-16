import { useEffect, useMemo, useState } from 'react';
import { getProviders, updatePipelineSeries } from '../../services/api';
import ProviderModelSelector from '../ProviderModelSelector';
import toast from '../ui/Toast';

/**
 * Two-select provider+model picker bound to `series.llm`. Saves on change so
 * the choice applies to every subsequent LLM call on this series (arc, idea,
 * prose, scripts, auto-run). Mirrors the Universe Builder `universe.llm` picker.
 *
 * Renders through the shared {@link ProviderModelSelector}; the series-specific
 * semantics (unset → "Active provider" fallback, save-on-change) live here.
 */
export default function SeriesLlmPicker({ series, onSeriesUpdate, disabled = false }) {
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);

  useEffect(() => {
    getProviders()
      .then((data) => {
        setProviders(data?.providers || []);
        setActiveProviderId(data?.activeProvider || null);
      })
      .catch(() => { /* dropdowns just show the "Active provider" fallback */ });
  }, []);

  const providerLabel = (id) => providers.find((p) => p.id === id)?.name || id || '—';
  const providerModels = useMemo(() => {
    const p = providers.find((x) => x.id === series.llm?.provider)
      || providers.find((x) => x.id === activeProviderId);
    return p?.models || [];
  }, [providers, activeProviderId, series.llm?.provider]);

  const saveLlm = async (next) => {
    const updated = await updatePipelineSeries(series.id, { llm: next }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to save provider choice');
      return null;
    });
    if (updated) onSeriesUpdate(updated);
  };

  // Bind to `?? ''` (NOT `|| activeProviderId`) — unset must select the
  // "Active provider" empty option, otherwise the dropdown would silently pin
  // the active provider as if the user had chosen it.
  return (
    <ProviderModelSelector
      providers={providers}
      selectedProviderId={series.llm?.provider ?? ''}
      selectedModel={series.llm?.model || ''}
      availableModels={providerModels}
      onProviderChange={(id) => saveLlm({ provider: id || null, model: null })}
      onModelChange={(model) => saveLlm({ ...(series.llm || {}), model: model || null })}
      label="AI provider"
      disabled={disabled}
      modelDisabled={providerModels.length === 0}
      compact
      alwaysShowModel
      emptyProviderOption={`Active provider (${providerLabel(activeProviderId)})`}
      emptyModelOption="Default model"
    />
  );
}
