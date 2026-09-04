import ProviderModelSelector from '../../../ProviderModelSelector';

// Compact provider/model/effort pins rendered directly on a schedule card, so
// the common "point this task at a different model and run it" loop doesn't
// require opening the config drawer. Presentational — the card owns the
// `useTaskModelPins` state so its Run button can gate on the same `saving` flag.
//
// `highlightToolUse` is on because a scheduled task IS an agent run: a task
// pinned to a local model that can't call tools narrates instead of working.
export default function TaskModelQuickControls({ pins, providers, loading = false, disabled = false }) {
  const {
    providerId, model, effort, effectiveProviderId, defaultProviderLabel,
    availableModels, saving, changeProvider, changeModel, changeEffort,
  } = pins;

  return (
    <div className="px-4 py-2.5 border-t border-port-border">
      <ProviderModelSelector
        providers={providers || []}
        selectedProviderId={providerId}
        effectiveProviderId={effectiveProviderId}
        selectedModel={model}
        availableModels={availableModels}
        onProviderChange={changeProvider}
        onModelChange={changeModel}
        effort={effort}
        onEffortChange={changeEffort}
        emptyProviderOption={defaultProviderLabel}
        emptyModelOption="Default model"
        alwaysShowModel
        compact
        highlightToolUse
        loading={loading}
        disabled={disabled || saving}
      />
    </div>
  );
}
