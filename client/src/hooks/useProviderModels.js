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
 * @param {function} [options.modelFilter] - `(modelId, provider) => boolean`
 *   predicate applied to each provider's selectable model list (after the
 *   sentinel strip). Use for capability-scoped pickers (e.g. vision-only). When
 *   set, the auto-selected / provider-change model is the first model that
 *   passes the filter rather than the provider's `defaultModel` (which may not
 *   qualify). Omit for the full selectable list.
 * @returns {{ providers, selectedProviderId, selectedModel, availableModels, selectedProvider, setSelectedProviderId, setSelectedModel, loading }}
 */
export default function useProviderModels({ filter, allowDefault = false, silent = false, modelFilter } = {}) {
  const [providers, setProviders] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(true);
  const hasSetInitialRef = useRef(false);

  // Resolve the model to pin when a provider is (auto-)selected. With a
  // modelFilter, the provider's defaultModel may not qualify (e.g. a vision
  // picker on a local backend whose default is a text model), so pick the first
  // model that passes the filter instead.
  const pickInitialModel = useCallback((provider) => {
    if (!modelFilter) return provider?.defaultModel || '';
    const models = filterSelectableModels(provider?.models || [provider?.defaultModel])
      .filter((m) => modelFilter(m, provider));
    return models[0] || '';
  }, [modelFilter]);

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
      setSelectedModel(pickInitialModel(filtered[0]));
    }
    setLoading(false);
  }, [filter, allowDefault, silent, pickInitialModel]);

  useEffect(() => { load(); }, [load]);

  const currentProvider = useMemo(
    () => providers.find(p => p.id === selectedProviderId),
    [providers, selectedProviderId]
  );

  const availableModels = useMemo(
    // No selected provider (allowDefault, or the brief pre-load window) → no
    // models. Guard before falling back to `[defaultModel]`, which would be
    // `[undefined]` and surface a bogus blank option. A `modelFilter` (e.g.
    // vision-only) is applied after the sentinel strip.
    () => {
      if (!currentProvider) return [];
      const models = filterSelectableModels(currentProvider.models || [currentProvider.defaultModel]);
      return modelFilter ? models.filter((m) => modelFilter(m, currentProvider)) : models;
    },
    [currentProvider, modelFilter]
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
    setSelectedModel(pickInitialModel(p));
  }, [providers, allowDefault, pickInitialModel]);

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
