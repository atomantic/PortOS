import { useEffect, useId, useState } from 'react';
import * as api from '../../services/api';
import ProviderModelSelector from '../ProviderModelSelector.jsx';

const emptyConfig = { workers: [], evaluator: null };

export default function PersistentMindSandboxControls({ capabilities, disabled, onSaved, onSavingChange }) {
  const id = useId();
  const [providers, setProviders] = useState([]);
  const [config, setConfig] = useState(capabilities?.sandboxDelegation || emptyConfig);
  const [enabled, setEnabled] = useState(capabilities?.delegateSandbox === true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    setConfig(capabilities?.sandboxDelegation || emptyConfig);
    setEnabled(capabilities?.delegateSandbox === true);
  }, [capabilities?.sandboxDelegation, capabilities?.delegateSandbox]);
  useEffect(() => {
    api.getProviders({ silent: true }).then((result) => setProviders((result.providers || [])
      .filter((provider) => provider.type === 'api' && provider.enabled !== false)))
      .catch((failure) => setError(failure.message || 'Could not load API models'));
  }, []);
  const renderRoute = (route, key, change) => {
    const provider = providers.find((entry) => entry.id === route?.providerId);
    const models = provider?.models || [];
    const available = route?.providerId && !provider
      ? [...providers, { id: route.providerId, name: `${route.providerId} (unavailable)`, models: [] }]
      : providers;
    return <ProviderModelSelector id={`${id}-${key}`} providers={available}
      selectedProviderId={route?.providerId || ''} selectedModel={route?.model || ''}
      availableModels={route?.model && !models.includes(route.model) ? [route.model, ...models] : models}
      label={key === 'evaluator' ? 'Evaluator provider' : `Worker ${Number(key.split('-')[1]) + 1} provider`}
      modelLabel={key === 'evaluator' ? 'Evaluator model' : `Worker ${Number(key.split('-')[1]) + 1} model`}
      emptyProviderOption="Select API provider" emptyModelOption="Select model" alwaysShowModel compose={false} disabled={disabled || saving} modelDisabled={!provider}
      onProviderChange={(providerId) => change({ providerId, model: providers.find((entry) => entry.id === providerId)?.models?.[0] || '' })}
      onModelChange={(model) => change({ ...route, model })} />;
  };
  const incomplete = !config.evaluator?.model || !config.evaluator?.providerId || !config.workers.length
    || config.workers.some((route) => !route.providerId || !route.model
      || (route.providerId === config.evaluator.providerId && route.model === config.evaluator.model));
  const save = async () => {
    setSaving(true);
    setError(null);
    onSavingChange?.(true);
    try {
      const patch = { delegateSandbox: enabled, sandboxDelegation: config };
      const result = await api.updateCosConfig({ persistentMindCapabilities: patch }, { silent: true });
      onSaved?.(result.persistentMindCapabilities || { ...capabilities, ...patch });
    } catch (failure) {
      setError(failure.message || 'Could not save delegation access');
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };
  return <section className="rounded border border-port-border p-4 space-y-3" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`} className="font-semibold text-port-text">Tool-free model delegation</h3>
    <p className="text-sm text-port-text-muted">Let the mind outsource coding, text, or animation source without queueing a CoS agent. Workers receive only the context packet the mind supplies. A trusted API model checks every criterion; neither model can use OS tools or execute the result.</p>
    <p className="text-xs text-port-text-muted">Approving a route permits its provider calls and transmission of supplied context. Choose free workers as desired; the evaluator may use paid quota. Evaluation is advisory. Keep credentials and private records out of context.</p>
    <label htmlFor={`${id}-enabled`} className="flex gap-2 text-sm text-port-text">
      <input id={`${id}-enabled`} type="checkbox" checked={enabled} disabled={disabled || saving} onChange={(event) => setEnabled(event.target.checked)} /> Allow tool-free delegation
    </label>
    <p className="text-sm text-port-text">Trusted evaluator</p>
    {renderRoute(config.evaluator, 'evaluator', (evaluator) => setConfig((current) => ({ ...current, evaluator })))}
    {config.evaluator && <button type="button" disabled={disabled || saving} className="min-h-10 text-sm text-port-text-muted" onClick={() => setConfig((current) => ({ ...current, evaluator: null }))}>Clear evaluator</button>}
    <p className="text-sm text-port-text">Approved workers</p>
    {config.workers.map((route, index) => <div key={index} className="flex flex-wrap gap-2 items-end">
      {renderRoute(route, `worker-${index}`, (next) => setConfig((current) => ({ ...current, workers: current.workers.map((entry, position) => position === index ? next : entry) })))}
      <button type="button" disabled={disabled || saving} className="min-h-10 text-sm text-port-text-muted" aria-label={`Remove worker ${index + 1}`} onClick={() => setConfig((current) => ({ ...current, workers: current.workers.filter((_, position) => position !== index) }))}>Remove</button>
    </div>)}
    <button type="button" disabled={disabled || saving || config.workers.length >= 20} className="min-h-10 rounded border border-port-border px-3 text-sm text-port-text" onClick={() => setConfig((current) => ({ ...current, workers: [...current.workers, { providerId: '', model: '' }] }))}>Add worker</button>
    {enabled && incomplete && <p className="text-xs text-port-warning">Select at least one worker and a different trusted evaluator before enabling.</p>}
    <button type="button" disabled={disabled || saving || (enabled && incomplete) || config.workers.some((route) => !route.providerId || !route.model) || (config.evaluator && (!config.evaluator.providerId || !config.evaluator.model))} className="min-h-10 rounded bg-port-accent px-3 text-sm text-white disabled:opacity-50" onClick={save}>{saving ? 'Saving…' : 'Save delegation access'}</button>
    {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
  </section>;
}
