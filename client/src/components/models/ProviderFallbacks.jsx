import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ListOrdered, Plus, Save, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import ListLoadError from '../ui/ListLoadError';
import PageSkeleton from '../ui/PageSkeleton';
import ProviderModelSelector from '../ProviderModelSelector';

/**
 * Fallbacks — ONE ordered list of provider presets tried in turn when a run
 * fails or its provider is unavailable, whichever preset the run started on.
 * The step after the one that failed runs next; past the last step the list
 * wraps to the first. A preset may appear more than once with different models
 * or effort (limits and availability differ per model). An empty list keeps the
 * legacy per-preset fallback behavior.
 */

export default function ProviderFallbacks() {
  const [providers, setProviders] = useState([]);
  const [entries, setEntries] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // A failed read stays an error with Retry: rendering it as an empty list
  // would read as "no fallback list" over a configured chain.
  useEffect(() => {
    let active = true;
    setLoadError(null);
    Promise.all([api.getProviders({ silent: true }), api.getProviderFallbacks({ silent: true })])
      .then(([provs, chain]) => {
        if (!active) return;
        setProviders((provs.providers || []).filter((p) => p.enabled !== false));
        setEntries(chain.entries || []);
      })
      .catch((err) => { if (active) setLoadError(err); });
    return () => { active = false; };
  }, [loadAttempt]);

  const byId = useMemo(() => Object.fromEntries(providers.map((p) => [p.id, p])), [providers]);

  const update = useCallback((next) => { setEntries(next); setDirty(true); }, []);
  const patch = (i, changes) => update(entries.map((e, at) => (at === i ? { ...e, ...changes } : e)));
  const move = (i, delta) => {
    const next = [...entries];
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item);
    update(next);
  };
  const add = () => {
    if (!providers.length) return;
    update([...entries, { providerId: providers[0].id }]);
  };

  const save = async () => {
    setSaving(true);
    const result = await api.saveProviderFallbacks(entries).catch(() => null);
    setSaving(false);
    if (!result) return;
    setEntries(result.entries);
    setDirty(false);
    toast.success('Fallback list saved');
  };

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <ListLoadError what="the fallback list" error={loadError} onRetry={() => setLoadAttempt((n) => n + 1)} />
      </div>
    );
  }
  if (!entries) return <PageSkeleton header="none" label="Loading fallbacks" cards={2} sidebar={false} />;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <p className="text-sm text-gray-400">
        When a run fails or its provider is unavailable, PortOS tries the next preset in this list after the one that
        failed, wrapping from the last back to the first. The same preset can appear several times with different
        models. With an empty list, each preset&apos;s own fallback setting applies.
      </p>

      {entries.length === 0 && (
        <div className="rounded border border-dashed border-port-border p-6 text-center text-sm text-gray-400">
          <ListOrdered size={20} aria-hidden="true" className="mx-auto mb-2" />
          No fallback list yet.
        </div>
      )}

      <ol className="space-y-2">
        {entries.map((entry, i) => {
          const provider = byId[entry.providerId];
          return (
            <li key={`${i}-${entry.providerId}`} className="flex flex-wrap items-end gap-2 rounded border border-port-border bg-port-card p-3">
              <span className="w-6 pb-2 text-sm text-gray-400">{i + 1}.</span>
              <div className="min-w-0 flex-1">
                <ProviderModelSelector
                  providers={providers}
                  selectedProviderId={entry.providerId}
                  selectedModel={entry.model || ''}
                  availableModels={provider?.models || []}
                  onProviderChange={(id) => patch(i, { providerId: id, model: undefined, effort: undefined })}
                  onModelChange={(model) => patch(i, { model: model || undefined, effort: undefined })}
                  effort={entry.effort || ''}
                  onEffortChange={(effort) => patch(i, { effort: effort || undefined })}
                  emptyModelOption="Preset default"
                  alwaysShowModel
                  label="Preset"
                />
              </div>
              <div className="flex gap-1">
                <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded border border-port-border p-2 text-gray-300 hover:text-white disabled:opacity-30"><ArrowUp size={14} aria-hidden="true" /></button>
                <button type="button" aria-label={`Move step ${i + 1} down`} disabled={i === entries.length - 1} onClick={() => move(i, 1)}
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded border border-port-border p-2 text-gray-300 hover:text-white disabled:opacity-30"><ArrowDown size={14} aria-hidden="true" /></button>
                <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => update(entries.filter((_, at) => at !== i))}
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 rounded border border-port-border p-2 text-port-error hover:bg-port-error/10"><Trash2 size={14} aria-hidden="true" /></button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={add} disabled={!providers.length}
          className="inline-flex items-center gap-1.5 rounded border border-port-border px-3 py-2 text-sm text-gray-200 hover:text-white disabled:opacity-50">
          <Plus size={14} aria-hidden="true" /> Add step
        </button>
        <button type="button" onClick={save} disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 rounded bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-50">
          <Save size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
