import {
  isProcessProvider,
  effortAwareModelOptions,
  filterRunnableProviders,
  resolveEffectiveProvider,
} from '../../utils/providers.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';

/**
 * Whether an agent job's saved provider choice resolves to a file-writing
 * CLI/TUI harness at save time. HTTP API providers can generate text, but they
 * cannot perform the filesystem work an agent job promises to do.
 */
export const hasRunnableAgentProvider = (providers, providerId, activeProviderId) => {
  const selectableProviders = filterRunnableProviders(providers, providerId);
  const { provider } = resolveEffectiveProvider(selectableProviders, providerId, activeProviderId);
  return isProcessProvider(provider);
};

/**
 * Shared provider/model/effort controls for persisted CoS agent jobs.
 *
 * Empty selections are intentional inherit/default sentinels. Changing the
 * provider clears the model and effort together, while a saved legacy model pin
 * remains visible through effortAwareModelOptions until the user changes it.
 * Selecting a model or effort from the inherited state pins the active provider
 * too, so a later active-provider change cannot make that override incompatible.
 * Existing API-only pins remain in the input list only long enough to be cleared;
 * new selections are restricted to providers with a CoS coding harness.
 */
export default function AgentJobProviderFields({
  data,
  providers,
  activeProviderId = '',
  onChange
}) {
  if (!providers?.length) return null;

  const selectableProviders = filterRunnableProviders(providers, data.providerId);
  const { provider: selectedProvider, usingActive } = resolveEffectiveProvider(
    selectableProviders,
    data.providerId,
    activeProviderId
  );
  const availableModels = effortAwareModelOptions(selectedProvider, data.model);
  const effectiveProviderId = usingActive ? (activeProviderId || undefined) : undefined;
  const patchWithActiveProvider = (patch) =>
    data.providerId || !activeProviderId ? patch : { providerId: activeProviderId, ...patch };
  const canInheritActiveProvider = isProcessProvider(
    selectableProviders.find(provider => provider.id === activeProviderId)
  );

  return (
    <div>
      <span className="text-xs text-gray-400 block mb-1">AI Provider &amp; Model (optional)</span>
      <ProviderModelSelector
        providers={selectableProviders}
        selectedProviderId={data.providerId || ''}
        effectiveProviderId={effectiveProviderId}
        selectedModel={data.model || ''}
        availableModels={availableModels}
        onProviderChange={providerId => onChange({ providerId, model: '', effort: '' })}
        onModelChange={model => onChange(patchWithActiveProvider({ model }))}
        effort={data.effort || ''}
        onEffortChange={effort => onChange(patchWithActiveProvider({ effort }))}
        compact
        emptyProviderOption={canInheritActiveProvider ? 'Default (active provider)' : 'Select a CLI/TUI provider'}
        emptyModelOption="Default model"
        alwaysShowModel
        highlightToolUse
      />
      {!data.providerId && !canInheritActiveProvider && (
        <p role="alert" className="mt-1 text-xs text-port-warning">
          Select a CLI/TUI provider before saving this agent job.
        </p>
      )}
    </div>
  );
}
