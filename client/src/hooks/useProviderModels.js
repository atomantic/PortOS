import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as api from '../services/api';
import { filterSelectableModels } from '../utils/providers';

/**
 * Hook for loading AI providers and managing two-step provider > model selection.
 * @param {Object} options
 * @param {function} [options.filter] - Filter function for providers (default: enabled only)
 * @param {boolean} [options.allowDefault] - When true, the empty string is a valid
 *   "no explicit selection / use the default" choice: the hook does NOT auto-select
 *   the first provider on load (both ids stay `''`), and picking a provider resets
 *   the model to `''` (the "default model" sentinel) rather than the provider's
 *   `defaultModel`. Pair with the `emptyProviderOption`/`emptyModelOption` props on
 *   `ProviderModelSelector`.
 * @param {boolean} [options.silent] - Suppress the default error toast when the
 *   provider fetch fails (the empty-list fallback still applies). Use when the
 *   picker is a secondary control whose failure shouldn't interrupt the page.
 * @returns {{ providers, selectedProviderId, selectedModel, availableModels, selectedProvider, setSelectedProviderId, setSelectedModel, loading }}
 */
export default function useProviderModels({ filter, allowDefault = false, silent = false } = {}) {
  const [providers, setProviders] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(true);
  const hasSetInitialRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api.getProviders(silent ? { silent: true } : undefined).catch((err) => {
      // Log even when `silent` suppresses the toast, so a failed fetch leaves
      // a breadcrumb (matches the prior inline console.warn behavior).
      console.warn(`⚠️ Provider list fetch failed: ${err?.message || err}`);
      return { providers: [] };
    });
    const filterFn = filter || (p => p.enabled);
    const filtered = (data.providers || []).filter(filterFn);
    setProviders(filtered);
    if (!allowDefault && filtered.length > 0 && !hasSetInitialRef.current) {
      hasSetInitialRef.current = true;
      setSelectedProviderId(filtered[0].id);
      setSelectedModel(filtered[0].defaultModel || '');
    }
    setLoading(false);
  }, [filter, allowDefault, silent]);

  useEffect(() => { load(); }, [load]);

  const currentProvider = useMemo(
    () => providers.find(p => p.id === selectedProviderId),
    [providers, selectedProviderId]
  );

  const availableModels = useMemo(
    // No selected provider (allowDefault, or the brief pre-load window) → no
    // models. Guard before falling back to `[defaultModel]`, which would be
    // `[undefined]` and surface a bogus blank option.
    () => (currentProvider ? filterSelectableModels(currentProvider.models || [currentProvider.defaultModel]) : []),
    [currentProvider]
  );

  const handleProviderChange = useCallback((id) => {
    setSelectedProviderId(id);
    if (allowDefault) {
      // Empty model = "use the default model" — don't pin the provider's
      // defaultModel, which would suppress the empty-sentinel choice.
      setSelectedModel('');
      return;
    }
    const p = providers.find(pr => pr.id === id);
    setSelectedModel(p?.defaultModel || '');
  }, [providers, allowDefault]);

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
