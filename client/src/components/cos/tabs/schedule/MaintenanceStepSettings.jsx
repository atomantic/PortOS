import { useState } from 'react';
import ProviderModelSelector from '../../../ProviderModelSelector';
import { effortAwareModelOptions } from '../../../../utils/providers';
import { updateMaintenanceStep } from '../../../../services/apiAgents';

/** Drafts apply to this run only, and only before the runner dispatches the stage. */
export default function MaintenanceStepSettings({ run, step, providers, loading, onSaved }) {
  const [draft, setDraft] = useState(() => ({ providerId: step.overrides?.providerId || '', model: step.overrides?.model || '', effort: step.overrides?.effort || '' }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editable = run.status === 'running' && !run.completed?.[step.id] && !step.startedAt && run.active?.stepId !== step.id;
  const provider = providers.find(entry => entry.id === draft.providerId);
  const dirty = ['providerId', 'model', 'effort'].some(key => draft[key] !== (step.overrides?.[key] || ''));
  const save = async () => {
    if (!editable || saving || !dirty || !provider || !draft.model) return;
    setSaving(true);
    setError('');
    const response = await updateMaintenanceStep(run.id, step.id, { ...draft, effort: draft.effort || null }, { silent: true })
      .catch(err => { setError(err.message); return null; });
    if (response?.run) onSaved(response.run);
    setSaving(false);
  };
  return <div className="w-full min-w-0">
    {editable ? <fieldset disabled={saving} className="space-y-2">
      <legend className="sr-only">Handler for {step.taskRef.taskType}</legend>
      <ProviderModelSelector providers={providers} selectedProviderId={draft.providerId} selectedModel={draft.model}
        availableModels={provider ? effortAwareModelOptions(provider, draft.model) : []}
        onProviderChange={providerId => setDraft({ providerId, model: '', effort: '' })}
        onModelChange={model => setDraft(current => ({ ...current, model }))}
        effort={draft.effort} onEffortChange={effort => setDraft(current => ({ ...current, effort }))}
        emptyProviderOption="Select a subscription provider" emptyModelOption="Select a model"
        alwaysShowModel layout="stacked" loading={loading} disabled={saving} />
      <p className="text-port-text-muted">Blank effort uses the task’s saved setting. Applies to this stage only.</p>
      <button type="button" onClick={save} disabled={saving || loading || !dirty || !provider || !draft.model}
        className="px-2 py-1 rounded bg-port-border disabled:opacity-50">{saving ? 'Saving…' : 'Save stage'}</button>
    </fieldset> : <p className="text-port-text-muted break-words">{step.overrides?.providerId} · {step.overrides?.model}{step.overrides?.effort ? ` · ${step.overrides.effort}` : ''}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
