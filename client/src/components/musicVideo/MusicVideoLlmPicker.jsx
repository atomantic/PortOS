import { useEffect, useState } from 'react';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import useProviderModels from '../../hooks/useProviderModels.js';
import { EMPTY_LLM_DRAFT } from '../../lib/musicVideoAutomation.js';

/**
 * Provider / model / effort for a Music Video text stage (#9545). `value` is the
 * draft `{ providerId, model, effort }` (all strings); a blank provider is Auto,
 * which the server resolves to an eligible TUI provider (visible as a Shell
 * session) before falling back to the active provider — so Auto is named in the
 * dropdown rather than left implicit.
 *
 * The hook only supplies the provider catalog; the parent owns the value. The
 * saved pin is restored into the hook once the catalog loads, and a pin whose
 * provider is gone is cleared back to Auto with a visible note rather than
 * silently kept.
 *
 * `emptyProviderOption` / `fallbackName` / `hint` let a per-stage row
 * (MusicVideoLlmStagesPicker) name its blank choice "Default" and drop the
 * direction picker's help text.
 */
const AUTO_OPTION = 'Auto — a TUI provider when one is eligible';
const AUTO_HINT = 'Auto prefers an enabled TUI provider so the work shows up as an attachable Shell session; pick an API provider to run without one. Applies to shot planning, the Cast & Sets direction and code authoring.';

export default function MusicVideoLlmPicker({
  idPrefix, value, onChange, disabled = false, label = 'Direction & planning LLM',
  emptyProviderOption = AUTO_OPTION, fallbackName = 'Auto', hint = AUTO_HINT,
}) {
  const llm = useProviderModels({ allowDefault: true, silent: true, withEffort: true });
  const { providers, loading, setSelectedProviderId, setSelectedModel } = llm;
  const [seeded, setSeeded] = useState(false);
  const [missingId, setMissingId] = useState('');
  const current = value || EMPTY_LLM_DRAFT;

  useEffect(() => {
    if (seeded || loading) return;
    setSeeded(true);
    if (!current.providerId) return;
    if (providers.some((p) => p.id === current.providerId)) {
      setSelectedProviderId(current.providerId);
      setSelectedModel(current.model || '');
    } else if (providers.length) {
      setMissingId(current.providerId);
      onChange({ ...EMPTY_LLM_DRAFT });
    }
  }, [seeded, loading, providers, current.providerId, current.model, setSelectedProviderId, setSelectedModel, onChange]);

  const pickProvider = (providerId) => {
    setMissingId('');
    setSelectedProviderId(providerId);
    onChange({ providerId, model: '', effort: '' });
  };
  const pickModel = (model) => {
    setSelectedModel(model);
    onChange({ ...current, model });
  };

  return (
    <div className="min-w-0" data-testid={`${idPrefix}-llm`}>
      <ProviderModelSelector
        providers={providers}
        selectedProviderId={llm.selectedProviderId}
        selectedModel={llm.selectedModel}
        availableModels={llm.availableModels}
        onProviderChange={pickProvider}
        onModelChange={pickModel}
        effort={current.effort}
        onEffortChange={(effort) => onChange({ ...current, effort })}
        label={label}
        emptyProviderOption={emptyProviderOption}
        emptyModelOption="Provider default"
        disabled={disabled}
        loading={loading}
        modelDisabled={llm.availableModels.length === 0}
        layout="stacked"
        compact
      />
      {missingId && <p className="text-[11px] text-port-warning mt-1" role="status">The saved provider “{missingId}” is no longer available — {fallbackName} will be used unless you pick another.</p>}
      {hint && <p className="text-[11px] text-port-text-muted mt-1">{hint}</p>}
    </div>
  );
}
