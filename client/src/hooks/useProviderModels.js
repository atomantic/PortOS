import { useState, useEffect, useCallback, useMemo } from 'react';
import * as api from '../services/api';

/**
 * Hook for loading AI providers and managing two-step provider > model selection.
 * @param {Object} options
 * @param {function} [options.filter] - Filter function for providers (default: enabled only)
 * @returns {{ providers, selectedProviderId, selectedModel, availableModels, selectedProvider, setSelectedProviderId, setSelectedModel, loading }}
 */
export default function useProviderModels({ filter } = {}) {
  const [providers, setProviders] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api.getProviders().catch(() => ({ providers: [] }));
    const filterFn = filter || (p => p.enabled);
    const filtered = (data.providers || []).filter(filterFn);
    setProviders(filtered);
    if (filtered.length > 0 && !selectedProviderId) {
      setSelectedProviderId(filtered[0].id);
      setSelectedModel(filtered[0].defaultModel || '');
    }
    setLoading(false);
  }, [filter, selectedProviderId]);

  useEffect(() => { load(); }, [load]);

  const currentProvider = useMemo(
    () => providers.find(p => p.id === selectedProviderId),
    [providers, selectedProviderId]
  );

  const availableModels = useMemo(
    () => (currentProvider?.models || [currentProvider?.defaultModel]).filter(Boolean),
    [currentProvider]
  );

  const handleProviderChange = useCallback((id) => {
    setSelectedProviderId(id);
    const p = providers.find(pr => pr.id === id);
    setSelectedModel(p?.defaultModel || '');
  }, [providers]);

  // Convenience: combined { providerId, model } for consumers
  const selectedProvider = selectedProviderId && selectedModel
    ? { providerId: selectedProviderId, model: selectedModel }
    : null;

  return {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    selectedProvider,
    setSelectedProviderId: handleProviderChange,
    setSelectedModel,
    loading
  };
}
