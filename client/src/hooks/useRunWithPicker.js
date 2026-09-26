import { useState } from 'react';
import useProviderModels from './useProviderModels.js';
import { enabledProcessProviderFilter } from '../utils/providers.js';

/**
 * Hook for "Run with" agent picker in app operations: manages provider/model/effort
 * selection for CoS task dispatch. Consolidates the duplicated picker setup across
 * app-detail surfaces (Issues, Pull Requests, SlashDoRunDrawer, LaunchVideoPanel).
 *
 * Owns the provider/model catalog fetch, effort state, and the provider-change
 * effort reset rule (clearing effort when the provider changes).
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
export default function useRunWithPicker() {
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
    preselectDefaults: true,
    silent: true,
    withEffort: true,
  });

  const [effort, setEffort] = useState('');

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

  // Request fragment with empty values dropped
  const pin = {
    ...(selectedProviderId ? { provider: selectedProviderId } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(effort ? { effort } : {}),
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
  };
}
