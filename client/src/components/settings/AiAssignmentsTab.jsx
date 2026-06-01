import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Bot, RefreshCw, Save, Search } from 'lucide-react';
import toast from '../ui/Toast';
import { getAiAssignments, updateAiAssignment } from '../../services/api';

const getDraft = (entry) => ({
  providerId: entry.providerId || '',
  model: entry.model || '',
});

const sameDraft = (entry, draft) =>
  (entry.providerId || '') === (draft?.providerId || '') &&
  (entry.model || '') === (draft?.model || '');

const providerName = (providers, id) =>
  providers.find((p) => p.id === id)?.name || id || 'Default';

const modelOptionsFor = (entry, providers, draftProviderId) => {
  if (Array.isArray(entry.modelOptions)) return entry.modelOptions;
  const provider = providers.find((p) => p.id === draftProviderId);
  return provider?.models || [];
};

const providerOptionsFor = (entry, providers) => {
  if (Array.isArray(entry.providerOptions)) return entry.providerOptions;
  const types = Array.isArray(entry.providerTypes) && entry.providerTypes.length
    ? new Set(entry.providerTypes)
    : null;
  return providers
    .filter((p) => !types || types.has(p.type))
    .map((p) => ({ id: p.id, name: `${p.name}${p.enabled ? '' : ' (disabled)'}` }));
};

export default function AiAssignmentsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [data, setData] = useState({ providers: [], assignments: [] });
  const [drafts, setDrafts] = useState({});
  const [query, setQuery] = useState('');
  const [area, setArea] = useState('all');
  const [scope, setScope] = useState('all');
  const [fromProvider, setFromProvider] = useState('');
  const [toProvider, setToProvider] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const next = await getAiAssignments({ silent: true }).catch((err) => {
      toast.error(`Failed to load AI assignments: ${err.message}`);
      return null;
    });
    if (next) {
      setData(next);
      setDrafts(Object.fromEntries((next.assignments || []).map((entry) => [entry.id, getDraft(entry)])));
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const areas = useMemo(
    () => ['all', ...Array.from(new Set((data.assignments || []).map((entry) => entry.area))).sort()],
    [data.assignments]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data.assignments || []).filter((entry) => {
      if (area !== 'all' && entry.area !== area) return false;
      if (scope !== 'all' && entry.scope !== scope) return false;
      if (!q) return true;
      return [
        entry.area,
        entry.label,
        entry.source,
        entry.providerId,
        entry.model,
        entry.notes,
      ].some((value) => String(value || '').toLowerCase().includes(q));
    });
  }, [area, data.assignments, query, scope]);

  const providerCounts = useMemo(() => {
    const counts = {};
    for (const entry of data.assignments || []) {
      if (!entry.providerId) continue;
      const id = entry.providerId;
      counts[id] = (counts[id] || 0) + 1;
    }
    return counts;
  }, [data.assignments]);

  const setDraft = (id, patch) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  };

  const saveEntry = async (entry) => {
    const draft = drafts[entry.id] || getDraft(entry);
    setSaving((prev) => ({ ...prev, [entry.id]: true }));
    const next = await updateAiAssignment(entry.id, {
      providerId: draft.providerId || null,
      model: draft.model || null,
    }, { silent: true }).catch((err) => {
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    setSaving((prev) => ({ ...prev, [entry.id]: false }));
    if (!next) return;
    setData(next);
    setDrafts(Object.fromEntries((next.assignments || []).map((item) => [item.id, getDraft(item)])));
    toast.success('AI assignment saved');
  };

  const runBulkMigration = async () => {
    if (!fromProvider || !toProvider || fromProvider === toProvider || bulkSaving) return;
    const targets = (data.assignments || []).filter((entry) => (
      entry.editable !== false &&
      entry.providerEditable !== false &&
      (drafts[entry.id]?.providerId || entry.providerId || '') === fromProvider &&
      providerOptionsFor(entry, data.providers).some((option) => option.id === toProvider)
    ));
    if (targets.length === 0) {
      toast.error('No editable assignments match that provider');
      return;
    }
    setBulkSaving(true);
    let latest = data;
    const targetDefaultModel = data.providers.find((p) => p.id === toProvider)?.defaultModel || '';
    for (const entry of targets) {
      const nextModel = entry.modelEditable === false ? (drafts[entry.id]?.model || '') : targetDefaultModel;
      const next = await updateAiAssignment(entry.id, {
        providerId: toProvider,
        model: nextModel || null,
      }, { silent: true }).catch((err) => {
        toast.error(`${entry.label}: ${err.message}`);
        return null;
      });
      if (next) latest = next;
    }
    setData(latest);
    setDrafts(Object.fromEntries((latest.assignments || []).map((item) => [item.id, getDraft(item)])));
    setBulkSaving(false);
    toast.success(`Migrated ${targets.length} assignment${targets.length === 1 ? '' : 's'}`);
  };

  if (loading) {
    return <div className="text-sm text-gray-400">Loading AI assignments...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-gray-200">
            <Bot size={18} className="text-port-accent" />
            <h2 className="text-lg font-semibold">AI Assignments</h2>
          </div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            {Object.entries(providerCounts).sort((a, b) => b[1] - a[1]).map(([id, count]) => (
              <span key={id} className="px-2 py-1 rounded bg-port-card border border-port-border text-gray-300">
                {providerName(data.providers, id)}: {count}
              </span>
            ))}
          </div>
        </div>

        <div className="bg-port-card border border-port-border rounded-lg p-3 space-y-2 min-w-full xl:min-w-[420px] xl:max-w-[520px]">
          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value={fromProvider}
              onChange={(e) => setFromProvider(e.target.value)}
              className="flex-1 bg-port-bg border border-port-border rounded px-2 py-2 text-sm text-white"
            >
              <option value="">From provider</option>
              {data.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="hidden sm:flex items-center text-gray-500">
              <ArrowRight size={16} />
            </div>
            <select
              value={toProvider}
              onChange={(e) => setToProvider(e.target.value)}
              className="flex-1 bg-port-bg border border-port-border rounded px-2 py-2 text-sm text-white"
            >
              <option value="">To provider</option>
              {data.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button
              type="button"
              onClick={runBulkMigration}
              disabled={!fromProvider || !toProvider || fromProvider === toProvider || bulkSaving}
              className="px-3 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded text-sm"
            >
              {bulkSaving ? 'Migrating...' : 'Migrate'}
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Bulk migration updates editable rows that currently use the source provider and resets their model to the target default.
          </p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search assignments"
            className="w-full bg-port-bg border border-port-border rounded pl-9 pr-3 py-2 text-sm text-white"
          />
        </div>
        <select value={area} onChange={(e) => setArea(e.target.value)} className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white">
          {areas.map((a) => <option key={a} value={a}>{a === 'all' ? 'All areas' : a}</option>)}
        </select>
        <select value={scope} onChange={(e) => setScope(e.target.value)} className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white">
          <option value="all">All scopes</option>
          <option value="global">Global</option>
          <option value="record">Record pins</option>
          <option value="runtime">Runtime call sites</option>
        </select>
        <button type="button" onClick={load} className="flex items-center justify-center gap-1.5 px-3 py-2 bg-port-border hover:bg-port-border/80 text-sm text-white rounded">
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto border border-port-border rounded-lg">
        <table className="min-w-full divide-y divide-port-border">
          <thead className="bg-port-card">
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2 font-medium">Area</th>
              <th className="px-3 py-2 font-medium min-w-[220px]">Assignment</th>
              <th className="px-3 py-2 font-medium min-w-[210px]">Provider</th>
              <th className="px-3 py-2 font-medium min-w-[220px]">Model</th>
              <th className="px-3 py-2 font-medium min-w-[160px]">Source</th>
              <th className="px-3 py-2 font-medium w-[90px]"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-port-border bg-port-bg">
            {filtered.map((entry) => {
              const draft = drafts[entry.id] || getDraft(entry);
              const providerOptions = providerOptionsFor(entry, data.providers);
              const modelOptions = modelOptionsFor(entry, data.providers, draft.providerId);
              const dirty = !sameDraft(entry, draft);
              return (
                <tr key={entry.id} className="align-top">
                  <td className="px-3 py-3 text-sm text-gray-300 whitespace-nowrap">
                    <div>{entry.area}</div>
                    <div className="mt-1 text-xs text-gray-600">{entry.scope}</div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-sm text-white">{entry.label}</div>
                    {entry.notes && <div className="mt-1 text-xs text-gray-500">{entry.notes}</div>}
                  </td>
                  <td className="px-3 py-3">
                    {entry.providerEditable === false ? (
                      <div className="text-sm text-gray-300 py-2">{providerName(data.providers, draft.providerId)}</div>
                    ) : (
                      <select
                        value={draft.providerId}
                        onChange={(e) => {
                          const nextProviderId = e.target.value;
                          const nextDefault = data.providers.find((p) => p.id === nextProviderId)?.defaultModel || '';
                          setDraft(entry.id, { providerId: nextProviderId, model: entry.modelEditable === false ? draft.model : nextDefault });
                        }}
                        className="w-full bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white"
                      >
                        <option value="">Default / unset</option>
                        {providerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {entry.modelEditable === false ? (
                      <div className="text-sm text-gray-300 py-2">{draft.model || 'Default'}</div>
                    ) : modelOptions.length > 0 ? (
                      <select
                        value={draft.model}
                        onChange={(e) => setDraft(entry.id, { model: e.target.value })}
                        className="w-full bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white"
                      >
                        <option value="">Default / auto</option>
                        {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <input
                        value={draft.model}
                        onChange={(e) => setDraft(entry.id, { model: e.target.value })}
                        placeholder="Default / auto"
                        className="w-full bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white placeholder-gray-600"
                      />
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs text-gray-500">
                    <div className="break-all">{entry.source}</div>
                    {entry.link && (
                      <a href={entry.link} className="inline-block mt-1 text-port-accent hover:underline">Open</a>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {entry.editable === false ? (
                      <span className="text-xs text-gray-600">Read only</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => saveEntry(entry)}
                        disabled={!dirty || saving[entry.id]}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded text-xs"
                      >
                        <Save size={12} />
                        {saving[entry.id] ? 'Saving' : 'Save'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan="6" className="px-3 py-8 text-center text-sm text-gray-500">No assignments match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
