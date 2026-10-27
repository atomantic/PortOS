import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getProviders } from '../../services/apiProviders';
import { getCosSchedule, updateCosTaskInterval, triggerCosOnDemandTask } from '../../services/apiAgents';
import ProviderModelSelector from '../ProviderModelSelector';

const TASK = 'model-comparison-refresh';
export default function ComparisonResearch({
  scope = 'all',
  selectedModels = [],
  onScopeChange,
}) {
  const [providers, setProviders] = useState([]);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState({ providerId: '', model: '', effort: '', executionOptions: {} });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([getProviders({ silent: true }), getCosSchedule({ silent: true })]).then(([data, schedule]) => {
      if (!active) return;
      setProviders(data.providers.filter(provider => provider.enabled !== false));
      const task = schedule.tasks[TASK];
      setSaved(task || { enabled: false });
      setDraft({
        providerId: task?.providerId || '',
        model: task?.model || '',
        effort: task?.effort || '',
        executionOptions: task?.executionOptions || {},
      });
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, []);
  const provider = providers.find(item => item.id === draft.providerId);
  const valid = Boolean(provider && (!provider.models?.length || provider.models.includes(draft.model)));
  const dirty = saved?.providerId !== draft.providerId
    || (saved?.model || '') !== (draft.model || '')
    || (saved?.effort || '') !== (draft.effort || '')
    || JSON.stringify(saved?.executionOptions || {}) !== JSON.stringify(draft.executionOptions || {});
  const save = () => {
    setBusy(true); setError(''); setMessage('');
    updateCosTaskInterval(TASK, { ...draft, enabled: true }, { silent: true }).then(result => {
      setSaved(result.interval); setMessage('Research provider saved. You can now run the task.');
    }).catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  const run = () => {
    setBusy(true); setError(''); setMessage('');
    const targetModels = scope === 'selected' ? selectedModels : null;
    triggerCosOnDemandTask(TASK, null, {
      provider: draft.providerId || undefined,
      model: draft.model || undefined,
      effort: draft.effort || undefined,
      executionOptions: draft.executionOptions && Object.keys(draft.executionOptions).length ? draft.executionOptions : undefined,
      targetModels,
      silent: true,
    }).then(result => {
      if (result.error) throw new Error(result.error);
      setMessage(`Research queued in CoS (${scope === 'selected' ? `selected models: ${selectedModels.length}` : 'all gaps'}). Follow the run there, then reload comparison data after it completes.`);
    }).catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  return <section className="bg-port-card border border-port-border rounded-2xl p-5 space-y-4" aria-label="Refresh model research">
    <h3 className="font-semibold text-lg">Refresh model research with CoS</h3>
    <p className="text-sm text-port-text-muted leading-relaxed">Choose a browsing-capable provider, model, thinking effort, and speed. The investigating agent will find the data, update this instance, and make a PR to PortOS to include the data in the shipped app. Running research uses that provider’s quota or API budget.</p>

    <div className="flex flex-wrap items-center gap-2 pt-1 pb-1" aria-label="Research scope">
      <span className="text-xs text-port-text-muted font-medium">Scope:</span>
      <button
        type="button"
        className={`px-3 py-1.5 text-xs rounded-lg border border-port-border ${scope === 'all' ? 'bg-port-accent text-port-on-accent font-medium' : 'bg-port-bg text-port-text-muted'}`}
        onClick={() => onScopeChange?.('all')}
      >
        All model gaps
      </button>
      <button
        type="button"
        disabled={selectedModels.length === 0}
        className={`px-3 py-1.5 text-xs rounded-lg border border-port-border ${scope === 'selected' ? 'bg-port-accent text-port-on-accent font-medium' : 'bg-port-bg text-port-text-muted'} disabled:opacity-50`}
        onClick={() => onScopeChange?.('selected')}
      >
        Selected models only ({selectedModels.length})
      </button>
      {scope === 'selected' && (
        <span className="text-xs text-port-text-muted break-all">
          Investigating {selectedModels.length} models: {selectedModels.join(', ') || 'None selected'}
        </span>
      )}
    </div>

    <div className="space-y-3">
      <ProviderModelSelector
        label="Research provider"
        modelLabel="Research model"
        compose={false}
        providers={providers}
        selectedProviderId={draft.providerId}
        selectedModel={draft.model}
        availableModels={provider?.models || []}
        effort={draft.effort}
        onEffortChange={effort => setDraft(previous => ({ ...previous, effort }))}
        executionOptions={draft.executionOptions}
        onExecutionOptionsChange={executionOptions => setDraft(previous => ({ ...previous, executionOptions }))}
        disabled={busy || !saved}
        onProviderChange={providerId => setDraft(previous => ({ ...previous, providerId, model: '', effort: '', executionOptions: {} }))}
        onModelChange={model => setDraft(previous => ({ ...previous, model }))}
        emptyProviderOption="Choose provider"
        emptyModelOption="Choose model"
        highlightToolUse={true}
      />
      <div className="flex flex-wrap gap-3 items-center">
        <button className="px-4 py-2.5 text-sm rounded-lg border border-port-border disabled:opacity-50" onClick={save} disabled={busy || !valid || (!dirty && saved?.enabled)}>Save research settings</button>
        <button className="px-4 py-2.5 text-sm rounded-lg bg-port-accent text-port-on-accent disabled:opacity-50" onClick={run} disabled={busy || dirty || !valid || !saved?.enabled || (scope === 'selected' && selectedModels.length === 0)}>Run research now</button>
      </div>
    </div>
    <p className="text-sm">Cadence: {saved?.type === 'cron' ? saved.cronExpression : 'On demand'}. <Link className="text-port-accent-text underline" to="/cos/schedule">Edit cadence, effort, prompt and view status in CoS Schedule</Link>.</p>
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="text-port-error">{error}</p>}
  </section>;
}
