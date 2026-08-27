import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Bot, RefreshCw, Save, Search } from 'lucide-react';
import toast from '../ui/Toast';
import FormField from '../ui/FormField';
import EffortSelect from '../cos/EffortSelect.jsx';
import ToolUseWarning from '../ui/ToolUseWarning.jsx';
import TabPills from '../ui/TabPills.jsx';
import { getAiAssignments, updateAiAssignment } from '../../services/api';
import useVisionModelIds from '../../hooks/useVisionModelIds.js';
import useToolUseModelIds from '../../hooks/useToolUseModelIds.js';
import {
  providerDisplayName,
  assignmentProviderOptions,
  assignmentModelOptions,
  assignmentDefaultModel,
  assignmentToolUseState,
  effortLevelsForProvider,
  effortAwareModelOptions,
  effortSurvivingModel,
  withToolUseOptionLabel,
} from '../../utils/providers.js';

const getDraft = (entry) => ({
  providerId: entry.providerId || '',
  model: entry.model || '',
  effort: entry.effort || '',
});

const sameDraft = (entry, draft) =>
  (entry.providerId || '') === (draft?.providerId || '') &&
  (entry.model || '') === (draft?.model || '') &&
  (entry.effort || '') === (draft?.effort || '');

// Rebuild the draft map from a server response without discarding edits the
// user has in-flight on OTHER rows: reset only the rows we just saved (and seed
// rows we've never seen), preserving every other row's existing draft.
const reconcileDrafts = (prev, assignments, savedIds) => {
  const saved = new Set(savedIds);
  const next = {};
  for (const item of assignments || []) {
    next[item.id] = saved.has(item.id) || !(item.id in prev) ? getDraft(item) : prev[item.id];
  }
  return next;
};

// Provider label with the settings-table's "Default" fallback for an unset id.
const providerName = (providers, id) => providerDisplayName(providers, id, 'Default');
const effortOptionsFor = (provider, model) => effortLevelsForProvider(provider, model) || [];

// Chip key for rows with no provider pinned. An empty string already means
// "no provider chip selected", so unset rows need their own sentinel to be
// selectable rather than collapsing into "show everything".
const UNSET_PROVIDER = '__unset__';

export default function AiAssignmentsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState({});
  const [data, setData] = useState({ providers: [], assignments: [] });
  const [drafts, setDrafts] = useState({});
  const [query, setQuery] = useState('');
  const [area, setArea] = useState('all');
  const [assignmentType, setAssignmentType] = useState('all');
  const [providerFilter, setProviderFilter] = useState('');
  const [fromProvider, setFromProvider] = useState('');
  const [fromModel, setFromModel] = useState('');
  const [toProvider, setToProvider] = useState('');
  const [toModel, setToModel] = useState('');
  const [toEffort, setToEffort] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);
  // Authoritative vision-capable ids straight from the local backends, so a
  // vision-filtered row (Scene evaluation) isn't reduced to an empty list by
  // the client's id regex not knowing a newer VLM family. This table renders a
  // <select> either way (no "none installed" claim), so it needs the map only.
  const { idsByProvider: visionIdsByProvider, loaded: visionLoaded } = useVisionModelIds();
  // Same authoritative-union treatment for the AGENT rows the server marks
  // `needsTools` (Creative Director treatment/plan, autofixer, CoS tasks, feature
  // agents, …). Ungated: this table always lists those rows, so there is no
  // "page that merely contains a non-agent picker" case to spare the scan for.
  const { idsByProvider: toolUseIdsByProvider, loaded: toolUseLoaded } = useToolUseModelIds();

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

  const assignmentTypes = useMemo(
    () => ['all', ...Array.from(new Set((data.assignments || []).map((entry) => entry.assignmentType))).filter(Boolean).sort()],
    [data.assignments]
  );

  const sourceProviders = useMemo(() => {
    const assigned = new Set((data.assignments || []).map((entry) => entry.providerId).filter(Boolean));
    const byId = new Map(data.providers.map((provider) => [provider.id, provider]));
    return Array.from(assigned, (id) => byId.get(id) || { id, name: id });
  }, [data.assignments, data.providers]);

  const sourceModels = useMemo(() => Array.from(new Set(
    (data.assignments || [])
      .filter((entry) => entry.providerId === fromProvider && entry.model)
      .map((entry) => entry.model)
  )).sort(), [data.assignments, fromProvider]);

  const targetProvider = data.providers.find((provider) => provider.id === toProvider);
  const targetModels = effortAwareModelOptions(targetProvider, '');

  const bulkTargets = useMemo(() => {
    if (!fromProvider || !toProvider) return [];
    return (data.assignments || []).filter((entry) => {
      const modelCompatible = !toModel || (
        entry.modelFilter === 'vision'
          ? assignmentModelOptions(entry, data.providers, toProvider, visionIdsByProvider).includes(toModel)
          : targetModels.includes(toModel)
      );
      return entry.editable !== false &&
        entry.providerEditable !== false &&
        entry.providerId === fromProvider &&
        (!fromModel || entry.model === fromModel) &&
        assignmentProviderOptions(entry, data.providers).some((option) => option.id === toProvider) &&
        modelCompatible;
    });
  }, [data.assignments, data.providers, fromModel, fromProvider, targetModels, toModel, toProvider, visionIdsByProvider]);

  // Everything except the provider chips, so the chip counts describe what the
  // OTHER filters left behind (faceted-filter behaviour) instead of a global
  // total that stops matching the table the moment you type in the search box.
  const preProviderFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data.assignments || []).filter((entry) => {
      if (area !== 'all' && entry.area !== area) return false;
      if (assignmentType !== 'all' && entry.assignmentType !== assignmentType) return false;
      if (!q) return true;
      return [
        entry.area,
        entry.assignmentType,
        entry.label,
        entry.source,
        entry.providerId,
        entry.model,
        entry.notes,
      ].some((value) => String(value || '').toLowerCase().includes(q));
    });
  }, [area, assignmentType, data.assignments, query]);

  const filtered = useMemo(() => {
    if (!providerFilter) return preProviderFiltered;
    return preProviderFiltered.filter((entry) => (
      providerFilter === UNSET_PROVIDER ? !entry.providerId : entry.providerId === providerFilter
    ));
  }, [preProviderFiltered, providerFilter]);

  const providerCounts = useMemo(() => {
    const counts = {};
    for (const entry of preProviderFiltered) {
      const id = entry.providerId || UNSET_PROVIDER;
      counts[id] = (counts[id] || 0) + 1;
    }
    // Keep the active chip on screen even when the other filters zero it out —
    // otherwise clicking Search strands the selection with no way to clear it.
    if (providerFilter) counts[providerFilter] ??= 0;
    return counts;
  }, [preProviderFiltered, providerFilter]);

  const providerTabs = useMemo(() => ([
    { id: '', label: 'All', count: preProviderFiltered.length },
    ...Object.entries(providerCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({
        id,
        label: id === UNSET_PROVIDER ? 'Default / unset' : providerName(data.providers, id),
        count,
      })),
  ]), [data.providers, preProviderFiltered.length, providerCounts]);

  const setDraft = (id, patch) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  };

  const saveEntry = async (entry) => {
    const draft = drafts[entry.id] || getDraft(entry);
    setSaving((prev) => ({ ...prev, [entry.id]: true }));
    const next = await updateAiAssignment(entry.id, {
      providerId: draft.providerId || null,
      model: draft.model || null,
      effort: draft.effort || null,
    }, { silent: true }).catch((err) => {
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    setSaving((prev) => ({ ...prev, [entry.id]: false }));
    if (!next) return;
    setData(next);
    setDrafts((prev) => reconcileDrafts(prev, next.assignments, [entry.id]));
    toast.success('AI assignment saved');
  };

  const runBulkMigration = async () => {
    if (!fromProvider || !toProvider || bulkSaving) return;
    if (bulkTargets.length === 0) {
      toast.error('No editable assignments match that provider');
      return;
    }
    setBulkSaving(true);
    let latest = data;
    const savedIds = [];
    for (const entry of bulkTargets) {
      const nextModel = entry.modelEditable === false
        ? (entry.model || '')
        : (toModel || (entry.modelFilter === 'vision'
          ? assignmentDefaultModel(entry, data.providers, toProvider, visionIdsByProvider)
          : ''));
      const next = await updateAiAssignment(entry.id, {
        providerId: toProvider,
        model: nextModel || null,
        ...(entry.effortEditable ? { effort: toEffort || null } : {}),
      }, { silent: true }).catch((err) => {
        toast.error(`${entry.label}: ${err.message}`);
        return null;
      });
      if (next) {
        latest = next;
        savedIds.push(entry.id);
      }
    }
    setData(latest);
    setDrafts((prev) => reconcileDrafts(prev, latest.assignments, savedIds));
    setBulkSaving(false);
    toast.success(`Replaced ${savedIds.length} assignment${savedIds.length === 1 ? '' : 's'}`);
  };

  if (loading) {
    return <div className="text-sm text-gray-400">Loading AI assignments...</div>;
  }

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-gray-200">
            <Bot size={18} className="text-port-accent" />
            <div>
              <h2 className="text-lg font-semibold">AI Assignments</h2>
              <p className="mt-0.5 text-sm text-gray-500">Manage persisted feature, workflow, and scheduled-task assignments.</p>
            </div>
          </div>
          <TabPills
            tabs={providerTabs}
            activeTab={providerFilter}
            // Re-clicking the active chip clears the filter, so the row needs no
            // separate "clear" affordance beyond the All chip.
            onChange={(id) => setProviderFilter(id === providerFilter ? '' : id)}
            variant="filter"
            size="sm"
            ariaLabel="Filter by provider"
            className="mt-2 max-w-full"
          />
        </div>

        <div className="w-full min-w-0 max-w-full shrink-0 bg-port-card border border-port-border rounded-lg p-3 space-y-2 xl:w-[720px]">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Replace assignments</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto_1fr_1fr]">
            <FormField label="Replace from provider" labelClassName="sr-only" className="min-w-0 flex-1">
              <select
                value={fromProvider}
                onChange={(e) => { setFromProvider(e.target.value); setFromModel(''); }}
                aria-label="Replace from provider"
                className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-2 text-sm text-white"
              >
                <option value="">From provider</option>
                {sourceProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
            <FormField label="Replace from model" labelClassName="sr-only" className="min-w-0">
              <select
                value={fromModel}
                onChange={(e) => setFromModel(e.target.value)}
                aria-label="Replace from model"
                disabled={!fromProvider}
                className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-2 text-sm text-white disabled:opacity-50"
              >
                <option value="">Any model</option>
                {sourceModels.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            </FormField>
            <div className="hidden sm:flex items-center justify-center text-gray-500">
              <ArrowRight size={16} />
            </div>
            <FormField label="Replace with provider" labelClassName="sr-only" className="min-w-0 flex-1">
              <select
                value={toProvider}
                onChange={(e) => { setToProvider(e.target.value); setToModel(''); setToEffort(''); }}
                aria-label="Replace with provider"
                className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-2 text-sm text-white"
              >
                <option value="">To provider</option>
                {data.providers.filter((p) => p.enabled !== false).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </FormField>
            <FormField label="Replace with model" labelClassName="sr-only" className="min-w-0">
              <select
                value={toModel}
                onChange={(e) => { setToModel(e.target.value); setToEffort(''); }}
                aria-label="Replace with model"
                disabled={!toProvider}
                className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-2 text-sm text-white disabled:opacity-50"
              >
                <option value="">Default model</option>
                {targetModels.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
            </FormField>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <EffortSelect
              provider={targetProvider}
              model={toModel || targetProvider?.defaultModel}
              value={toEffort}
              onChange={setToEffort}
              label="Target effort"
              labelClassName="sr-only"
              fieldClassName="min-w-0 sm:w-48"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-2 text-sm text-white"
            />
            <button
              type="button"
              onClick={runBulkMigration}
              disabled={!fromProvider || !toProvider || bulkTargets.length === 0 || bulkSaving}
              className="shrink-0 px-3 py-2 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white rounded text-sm"
            >
              {bulkSaving ? 'Replacing...' : 'Replace all matches'}
            </button>
          </div>
          <p className="text-xs text-gray-500">
            {fromProvider && toProvider ? `${bulkTargets.length} compatible match${bulkTargets.length === 1 ? '' : 'es'}. ` : ''}
            Match every persisted assignment on a provider, optionally narrow by model, then point compatible assignments to the new provider and model. Effort applies to scheduled assignments that persist it.
          </p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <FormField label="Search assignments" labelClassName="sr-only" className="flex-1">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search assignments"
              aria-label="Search assignments"
              className="w-full bg-port-bg border border-port-border rounded pl-9 pr-3 py-2 text-sm text-white"
            />
          </FormField>
        </div>
        <FormField label="Filter by area" labelClassName="sr-only" className="contents">
          <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="Filter by area" className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white">
            {areas.map((a) => <option key={a} value={a}>{a === 'all' ? 'All areas' : a}</option>)}
          </select>
        </FormField>
        <FormField label="Filter by assignment type" labelClassName="sr-only" className="contents">
          <select value={assignmentType} onChange={(e) => setAssignmentType(e.target.value)} aria-label="Filter by assignment type" className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white">
            {assignmentTypes.map((type) => <option key={type} value={type}>{type === 'all' ? 'All assignment types' : type}</option>)}
          </select>
        </FormField>
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
              <th className="px-3 py-2 font-medium min-w-[130px]">Effort</th>
              <th className="px-3 py-2 font-medium min-w-[160px]">Source</th>
              <th className="px-3 py-2 font-medium w-[90px]"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-port-border bg-port-bg">
            {filtered.map((entry) => {
              const draft = drafts[entry.id] || getDraft(entry);
              const selectedProvider = data.providers.find((p) => p.id === (draft.providerId || data.activeProvider));
              const providerOptions = assignmentProviderOptions(entry, data.providers);
              const modelOptions = assignmentModelOptions(entry, data.providers, draft.providerId, visionIdsByProvider);
              const dirty = !sameDraft(entry, draft);
              // Agent rows: mark each model option and warn when the EFFECTIVE
              // model isn't a recognized tool-caller. Same server flag, same
              // helper, same copy as the Creative Director drawer — which links
              // here, so the pin it warns about must not be silently editable.
              const { annotate: annotateToolUse, effectiveModel, incapable: toolIncapable } =
                assignmentToolUseState(entry, selectedProvider, draft.model, toolUseIdsByProvider, toolUseLoaded);
              // Choosing a provider seeds its default model; for a vision row
              // that seed is only correct once the capability scan has settled.
              // Picking during it leaves a blank model pin, which the evaluator
              // resolves to the provider's own (possibly text-only) default.
              const visionUnknown = entry.modelFilter === 'vision' && !visionLoaded;
              return (
                <tr key={entry.id} className="align-top">
                  <td className="px-3 py-3 text-sm text-gray-300 whitespace-nowrap">
                    <div>{entry.area}</div>
                    <div className="mt-1 text-xs text-gray-600">{entry.assignmentType}</div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="text-sm text-white">{entry.label}</div>
                    {entry.notes && <div className="mt-1 text-xs text-gray-500">{entry.notes}</div>}
                  </td>
                  <td className="px-3 py-3">
                    {entry.providerEditable === false ? (
                      <div className="text-sm text-gray-300 py-2">{providerName(data.providers, draft.providerId)}</div>
                    ) : (
                      <FormField label={`Provider for ${entry.label}`} labelClassName="sr-only">
                        <select
                          value={draft.providerId}
                          onChange={(e) => {
                            const nextProviderId = e.target.value;
                            // Vision-filtered rows (e.g. Scene evaluation) seed the
                            // first eligible VLM when the provider default is text-only.
                            const nextDefault = assignmentDefaultModel(entry, data.providers, nextProviderId, visionIdsByProvider);
                            setDraft(entry.id, { providerId: nextProviderId, model: entry.modelEditable === false ? draft.model : nextDefault, effort: '' });
                          }}
                          aria-label={`Provider for ${entry.label}`}
                          disabled={visionUnknown}
                          className="w-full bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white disabled:opacity-50"
                        >
                          <option value="">Default / unset</option>
                          {providerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </FormField>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {entry.modelEditable === false ? (
                      <div className="text-sm text-gray-300 py-2">{draft.model || 'Default'}</div>
                    ) : modelOptions.length > 0 ? (
                      <FormField label={`Model for ${entry.label}`} labelClassName="sr-only">
                        <select
                          value={draft.model}
                          onChange={(e) => setDraft(entry.id, {
                            model: e.target.value,
                            effort: effortSurvivingModel(selectedProvider, e.target.value, draft.effort),
                          })}
                          aria-label={`Model for ${entry.label}`}
                          className="w-full bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white"
                        >
                          <option value="">Default / auto</option>
                          {modelOptions.map((m) => (
                            <option key={m} value={m}>
                              {annotateToolUse
                                ? withToolUseOptionLabel(m, m, selectedProvider, toolUseIdsByProvider)
                                : m}
                            </option>
                          ))}
                        </select>
                      </FormField>
                    ) : (
                      <FormField label={`Model for ${entry.label}`} labelClassName="sr-only">
                        <input
                          value={draft.model}
                          onChange={(e) => setDraft(entry.id, { model: e.target.value })}
                          placeholder="Default / auto"
                          aria-label={`Model for ${entry.label}`}
                          className="w-full bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white placeholder-gray-600"
                        />
                      </FormField>
                    )}
                    {toolIncapable && (
                      <ToolUseWarning model={effectiveModel} isProviderDefault={!draft.model} className="mt-1.5">
                        <Link to="/models/llms" className="underline hover:text-port-warning/80">Browse models</Link>.
                      </ToolUseWarning>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {entry.effortEditable && effortOptionsFor(selectedProvider, draft.model || selectedProvider?.defaultModel).length > 0 ? (
                      <EffortSelect
                        provider={selectedProvider}
                        model={draft.model || selectedProvider?.defaultModel}
                        value={draft.effort}
                        onChange={(effort) => setDraft(entry.id, { effort })}
                        label={`Effort for ${entry.label}`}
                        labelClassName="sr-only"
                        className="w-full bg-port-card border border-port-border rounded px-2 py-2 text-sm text-white"
                      />
                    ) : (
                      <span className="text-sm text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs text-gray-500">
                    <div className="break-all">{entry.source}</div>
                    {entry.link && (
                      <Link to={entry.link} className="inline-block mt-1 text-port-accent hover:underline">Open</Link>
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
                <td colSpan="7" className="px-3 py-8 text-center text-sm text-gray-500">No assignments match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
