import { useEffect, useRef, useState } from 'react';
import useProviderModels from './useProviderModels.js';
import { enabledProcessProviderFilter } from '../utils/providers.js';

/**
 * Hook for "Run with" agent picker in app operations: manages provider/model/effort
 * selection for CoS task dispatch. Consolidates the duplicated picker setup across
 * app-detail surfaces (Issues, Pull Requests, SlashDoRunDrawer, LaunchVideoPanel).
 *
 * Owns the provider/model catalog fetch, effort state, and the provider-change
 * effort reset rule (clearing effort when the provider changes). `seed` (a saved
 * `{ provider, model, effort }`) is applied once, after the catalog has loaded,
 * so a stored pin is not lost to the catalog's own initial selection.
 *
 * @returns {{
 *   selectorProps: Object,      - All props to spread onto ProviderModelSelector
 *   pin: Object,                - Request fragment { provider?, model?, effort? }
 *   providers: Array,
 *   selectedProviderId: string,
 *   selectedModel: string,
 *   availableModels: Array,
 *   effort: string,
 *   setEffort: Function,
 * }}
 */
export default function useRunWithPicker({ preselectDefaults = true, seed = null } = {}) {
  const {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    setSelectedProviderId,
    setSelectedModel,
    loading,
  } = useProviderModels({
    filter: enabledProcessProviderFilter,
    allowDefault: true,
    preselectDefaults,
    silent: true,
    withEffort: true,
  });

  const [effort, setEffort] = useState('');
  const seeded = useRef(false);
  useEffect(() => {
    if (!seed || seeded.current || loading) return;
    seeded.current = true;
    if (seed.provider) setSelectedProviderId(seed.provider);
    if (seed.model) setSelectedModel(seed.model);
    if (seed.effort) setEffort(seed.effort);
  }, [seed, loading, setSelectedProviderId, setSelectedModel]);

  const selectorProps = {
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    loading,
    onProviderChange: (id) => {
      setSelectedProviderId(id);
      setEffort('');
    },
    onModelChange: setSelectedModel,
    effort,
    onEffortChange: setEffort,
    emptyProviderOption: 'Auto (default)',
    emptyModelOption: 'Default model',
    highlightToolUse: true,
  };

  // Request fragment matching the original pattern: include all fields,
  // matching the previous behavior of `provider || undefined, model || undefined, effort || undefined`
  const pin = {
    provider: selectedProviderId || undefined,
    model: selectedModel || undefined,
    effort: effort || undefined,
  };

  // Also expose individual properties for convenience and agentPicker compatibility
  return {
    selectorProps,
    pin,
    providers,
    selectedProviderId,
    selectedModel,
    availableModels,
    loading,
    effort,
    setEffort,
    setSelectedProviderId,
    setSelectedModel,
  };
}
