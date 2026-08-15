import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as api from '../services/api';
import { filterSelectableModels, selectableModelsForProvider, withStaleAntigravityPin } from '../utils/providers';

// The provider's selectable model source: its `models` list, or — when that
// list is empty (a cloud/manual provider configured with only a defaultModel,
// where `[]` is truthy so `||` wouldn't fall through) — its defaultModel.
//
// `withEffort` then applies any provider-specific rewrite — today that means
// Antigravity lists BASE models (`gemini-3.6-flash`) rather than one row per
// baked-in effort tier. It is OPT-IN because for a picker with no effort
// control the suffixed ids are the ONLY way to express a tier: collapsing them
// there would silently strip the capability rather than relocate it.
const sourceModels = (provider, withEffort) => {
  const models = provider?.models?.length ? provider.models : [provider?.defaultModel];
  return withEffort ? selectableModelsForProvider(provider, models) : models;
};

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
 *
 *   A `modelFilter` whose IDENTITY changes is supported and expected: a vision
 *   picker starts on the client-side id regex and widens once the server's
 *   authoritative capability list resolves (`useVisionModelIds`). The hook then
 *   re-runs its initial pick — without refetching the provider list — so a
 *   selection the first, blinder filter couldn't make isn't frozen at `''`.
 *   Once the user picks (or clears) a model, that wins and the re-pick stands
 *   down. Memoize the predicate (`useCallback`) so it only changes when its
 *   inputs do.
 * @param {boolean} [options.withEffort] - Set when the caller also renders an
 *   effort control (`ProviderModelSelector`'s `effort`/`onEffortChange`) and
 *   threads the value to the server. Providers whose CLI bakes the reasoning
 *   tier into the model id — Antigravity's `gemini-3.6-flash-low|-medium|-high`
 *   — then list BASE models instead, with effort picked separately. Leave off
 *   for a picker with no effort control: there the suffixed ids are the only
 *   way to express a tier, so collapsing them would strip the capability.
 * @returns {{ providers, selectedProviderId, selectedModel, availableModels, selectedProvider, setSelectedProviderId, setSelectedModel, loading }}
 */
export default function useProviderModels({ filter, allowDefault = false, silent = false, modelFilter, withEffort = false } = {}) {
  const [providers, setProviders] = useState([]);
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [loading, setLoading] = useState(true);
  const hasSetInitialRef = useRef(false);
  // Latched once the model is chosen deliberately — a picker change, or a
  // caller restoring a saved pin. The auto re-pick below then stands down for
  // good, so a deliberate CLEAR (`''`) is not silently refilled when the filter
  // later widens; `selectedModel === ''` alone can't carry that distinction,
  // since it is also what a filter that matched nothing produces.
  const userPickedModelRef = useRef(false);

  // Resolve the model to pin when a provider is (auto-)selected. With a
  // modelFilter, the provider's defaultModel may not qualify (e.g. a vision
  // picker on a local backend whose default is a text model), so pick the first
  // model that passes the filter instead.
  const pickInitialModel = useCallback((provider) => {
    if (!modelFilter) return provider?.defaultModel || '';
    const models = filterSelectableModels(sourceModels(provider, withEffort))
      .filter((m) => modelFilter(m, provider));
    return models[0] || '';
  }, [modelFilter, withEffort]);

  // `load` must NOT depend on `pickInitialModel` (and so on `modelFilter`): a
  // caller whose filter identity changes when a capability list resolves would
  // otherwise re-run the whole `api.getProviders()` fetch for a change that
  // needs no new data. The ref hands the async body the freshest picker without
  // pulling it into the dependency list.
  const pickInitialModelRef = useRef(pickInitialModel);
  pickInitialModelRef.current = pickInitialModel;

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
      setSelectedModel(pickInitialModelRef.current(filtered[0]));
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
    // `[undefined]` and surface a bogus blank option. A `modelFilter` (e.g.
    // vision-only) is applied after the sentinel strip.
    () => {
      if (!currentProvider) return [];
      // sourceModels falls back to [defaultModel] when `models` is empty (an
      // `[]` is truthy, so a bare `||` would leave the dropdown empty for a
      // cloud/manual provider configured with only a defaultModel).
      const models = filterSelectableModels(sourceModels(currentProvider, withEffort));
      const filtered = modelFilter ? models.filter((m) => modelFilter(m, currentProvider)) : models;
      // Legacy-pin escape hatch (see `withStaleAntigravityPin`): only relevant
      // once the list has been collapsed to base models, so it rides `withEffort`.
      return withEffort ? withStaleAntigravityPin(currentProvider, filtered, selectedModel) : filtered;
    },
    [currentProvider, modelFilter, selectedModel, withEffort]
  );

  // Re-run the initial pick when the `modelFilter`'s identity changes. Without
  // this, `hasSetInitialRef` freezes the auto-pick at whatever the FIRST filter
  // produced: a vision picker running on the client id regex alone returns `''`
  // for a backend whose only VLM the regex doesn't know (`gemma4`), and the
  // authoritative list landing a moment later never gets a say — leaving a
  // "no vision model" blocker next to a now-populated dropdown. Scoped to
  // filtered pickers (an unfiltered one pins `defaultModel`, which needs no
  // revision) and to a selection that is still the hook's own.
  useEffect(() => {
    if (!modelFilter || allowDefault || userPickedModelRef.current) return;
    if (!hasSetInitialRef.current || !currentProvider) return;
    // Still valid under the current filter → nothing to revise.
    if (selectedModel && availableModels.includes(selectedModel)) return;
    const next = pickInitialModel(currentProvider);
    if (next !== selectedModel) setSelectedModel(next);
  }, [modelFilter, allowDefault, currentProvider, availableModels, selectedModel, pickInitialModel]);

  // A user pick latches: the re-pick above never overrides it, in either
  // direction (a chosen model, or a deliberate clear).
  const handleModelChange = useCallback((model) => {
    userPickedModelRef.current = true;
    setSelectedModel(model);
  }, []);

  const handleProviderChange = useCallback((id) => {
    setSelectedProviderId(id);
    // The model that follows a provider change is auto-picked, not user-picked,
    // so it stays eligible for the re-pick above if the filter widens later.
    userPickedModelRef.current = false;
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
    setSelectedModel: handleModelChange,
    loading
  };
}
