import { useEffect, useId, useMemo, useState } from 'react';
import * as api from '../../services/api';
import {
  filterHardwareCompatibleProviderModels,
  filterSelectableModels,
  selectableModelsForProvider,
} from '../../utils/providers.js';
import toast from '../ui/Toast';

const normalizeEntries = (value) => (Array.isArray(value) ? value : [])
  .filter((entry) => typeof entry?.providerId === 'string' && typeof entry?.model === 'string')
  .map((entry) => ({ providerId: entry.providerId, model: entry.model }));

const modelId = (entry) => typeof entry === 'string' ? entry : entry?.id;

const modelsFor = (provider) => filterHardwareCompatibleProviderModels(
  filterSelectableModels(selectableModelsForProvider(
    provider,
    provider?.models?.length ? provider.models : [provider?.defaultModel],
  )),
  provider,
).map(modelId).filter(Boolean);

const providerLabel = (provider) => `${provider.name || provider.id} (${provider.type})`;

export default function PersistentMindTaskModelAllowlistControls({
  capabilities,
  disabled = false,
  onSaved,
  onSavingChange,
}) {
  const idPrefix = useId();
  const [providers, setProviders] = useState([]);
  const [entries, setEntries] = useState(() => normalizeEntries(capabilities?.taskModelAllowlist));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const policyInvalid = capabilities?.taskModelAllowlistInvalid === true;

  useEffect(() => {
    setEntries(normalizeEntries(capabilities?.taskModelAllowlist));
  }, [capabilities?.schemaVersion, capabilities?.taskModelAllowlist]);

  useEffect(() => {
    api.getProviders({ silent: true })
      .then((response) => setProviders((response?.providers || []).filter((provider) => (
        provider.enabled !== false && (provider.type === 'cli' || provider.type === 'tui')
      ))))
      .catch((requestError) => setError(requestError?.message || 'Coding providers are unavailable'));
  }, []);

  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const availableProviders = useMemo(() => {
    const current = entries.map((entry) => providerById.get(entry.providerId)).filter(Boolean);
    const unavailable = entries
      .filter((entry) => !providerById.has(entry.providerId))
      .map((entry) => ({ id: entry.providerId, name: `${entry.providerId} (no longer available)`, type: 'unavailable', models: [] }));
    return [...providers, ...current.filter((provider) => !providers.includes(provider)), ...unavailable]
      .filter((provider, index, list) => list.findIndex((candidate) => candidate.id === provider.id) === index);
  }, [entries, providerById, providers]);

  const save = async (nextEntries) => {
    const previous = entries;
    const deduped = [...new Map(nextEntries.map((entry) => [`${entry.providerId}\0${entry.model}`, entry])).values()];
    setEntries(deduped);
    setSaving(true);
    setError(null);
    onSavingChange?.(true);
    try {
      const next = {
        schemaVersion: 3,
        createTasks: capabilities?.createTasks === true,
        readPortos: capabilities?.readPortos === true,
        writePortos: capabilities?.writePortos === true,
        taskModelAllowlist: deduped,
        ...(Array.isArray(capabilities?.allowedAppIds) ? { allowedAppIds: capabilities.allowedAppIds } : {}),
      };
      await api.updateCosConfig({ persistentMindCapabilities: next }, { silent: true });
      onSaved?.(next);
      toast.success(deduped.length ? 'Persistent mind task models restricted' : 'Persistent mind task model restriction cleared');
    } catch (requestError) {
      setEntries(previous);
      setError(requestError?.message || 'Could not save the task model policy');
      toast.error(requestError?.message || 'Could not save the task model policy');
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  const addEntry = () => {
    const provider = availableProviders.find((candidate) => modelsFor(candidate).length > 0);
    if (!provider) {
      setError('No selectable coding models are available. Configure a CLI/TUI provider first.');
      return;
    }
    save([...entries, { providerId: provider.id, model: modelsFor(provider)[0] }]);
  };

  const updateEntry = (index, patch) => {
    const next = entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry);
    if (patch.providerId) {
      const provider = providerById.get(patch.providerId);
      const models = modelsFor(provider);
      next[index].model = models[0] || '';
    }
    if (!next[index].model) return;
    save(next);
  };

  const removeEntry = (index) => save(entries.filter((_, entryIndex) => entryIndex !== index));

  return (
    <section className="rounded border border-port-border bg-port-bg/40 p-3" aria-labelledby={`${idPrefix}-heading`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`${idPrefix}-heading`} className="text-sm font-semibold text-port-text">Task model allowlist</h3>
          <p className="mt-1 text-xs leading-relaxed text-port-text-muted">Limit the models the mind may choose when it queues agent tasks. This does not change the model used by the mind itself.</p>
        </div>
        <button
          type="button"
          onClick={addEntry}
          disabled={disabled || saving}
          className="rounded border border-port-accent/40 px-3 py-1.5 text-xs font-medium text-port-accent hover:bg-port-accent/10 disabled:opacity-50"
        >
          Add model
        </button>
      </div>
      {error && <p className="mt-3 rounded border border-port-warning/30 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">{error}</p>}
      {policyInvalid && <p className="mt-3 rounded border border-port-warning/30 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">The saved policy is invalid, so task model selection is currently blocked. Add a valid model pair to repair it.</p>}
      {!policyInvalid && entries.length === 0 ? (
        <p className="mt-3 text-xs text-port-text-muted">No restriction configured — all enabled coding-provider models remain available.</p>
      ) : !policyInvalid && (
        <div className="mt-3 space-y-2">
          {entries.map((entry, index) => {
            const provider = providerById.get(entry.providerId);
            const models = modelsFor(provider);
            const stale = !provider || !models.includes(entry.model);
            return (
              <div key={`${entry.providerId}-${entry.model}-${index}`} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <label htmlFor={`${idPrefix}-provider-${index}`} className="mb-1 block text-[11px] text-port-text-muted">Provider</label>
                  <select
                    id={`${idPrefix}-provider-${index}`}
                    value={entry.providerId}
                    disabled={disabled || saving}
                    onChange={(event) => updateEntry(index, { providerId: event.target.value })}
                    className="w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs text-port-text"
                  >
                    {availableProviders.map((candidate) => <option key={candidate.id} value={candidate.id}>{providerLabel(candidate)}</option>)}
                  </select>
                </div>
                <div className="min-w-0 flex-1">
                  <label htmlFor={`${idPrefix}-model-${index}`} className="mb-1 block text-[11px] text-port-text-muted">Model</label>
                  <select
                    id={`${idPrefix}-model-${index}`}
                    value={entry.model}
                    disabled={disabled || saving || !provider}
                    onChange={(event) => updateEntry(index, { model: event.target.value })}
                    className={`w-full rounded border bg-port-bg px-2 py-1.5 text-xs text-port-text ${stale ? 'border-port-warning' : 'border-port-border'}`}
                  >
                    {stale && <option value={entry.model}>{entry.model} (no longer available)</option>}
                    {models.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => removeEntry(index)}
                  disabled={disabled || saving}
                  className="self-start rounded border border-port-border px-2 py-1.5 text-xs text-port-text-muted hover:border-port-warning hover:text-port-warning sm:self-end"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-port-text-muted">Only exact provider/model pairs are accepted at queue time. A model removed from its provider is rejected until you remove it here.</p>
    </section>
  );
}
