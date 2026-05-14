import { useEffect, useMemo, useState } from 'react';
import { getProviders, updatePipelineSeries } from '../../services/api';
import toast from '../ui/Toast';

/**
 * Two-select provider+model picker bound to `series.llm`. Saves on change so
 * the choice applies to every subsequent LLM call on this series (arc, idea,
 * prose, scripts, auto-run). Mirrors the Universe Builder `universe.llm` picker.
 */
export default function SeriesLlmPicker({ series, onSeriesUpdate, disabled = false }) {
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);

  useEffect(() => {
    getProviders()
      .then((data) => {
        setProviders(data?.providers || []);
        setActiveProviderId(data?.activeProvider || null);
      })
      .catch(() => { /* dropdowns just show the "Active provider" fallback */ });
  }, []);

  const providerLabel = (id) => providers.find((p) => p.id === id)?.name || id || '—';
  const providerModels = useMemo(() => {
    const p = providers.find((x) => x.id === series.llm?.provider)
      || providers.find((x) => x.id === activeProviderId);
    return p?.models || [];
  }, [providers, activeProviderId, series.llm?.provider]);

  const saveLlm = async (next) => {
    const updated = await updatePipelineSeries(series.id, { llm: next }).catch((err) => {
      toast.error(err.message || 'Failed to save provider choice');
      return null;
    });
    if (updated) onSeriesUpdate(updated);
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Bind to `?? ''` (NOT `|| activeProviderId || ''`) — unset must select
          the "Active provider" empty option, otherwise the dropdown would
          silently pin the active provider as if the user had chosen it. */}
      <select
        value={series.llm?.provider ?? ''}
        onChange={(e) => saveLlm({ provider: e.target.value || null, model: null })}
        disabled={disabled}
        title="AI provider — applies to every LLM operation on this series"
        className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs disabled:opacity-40"
      >
        <option value="">Active provider ({providerLabel(activeProviderId)})</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <select
        value={series.llm?.model || ''}
        onChange={(e) => saveLlm({ ...(series.llm || {}), model: e.target.value || null })}
        disabled={disabled || providerModels.length === 0}
        title="Model"
        className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs disabled:opacity-40 max-w-[180px]"
      >
        <option value="">Default model</option>
        {providerModels.map((m) => {
          const id = typeof m === 'string' ? m : m.id;
          const label = typeof m === 'string' ? m : (m.name || m.id);
          return <option key={id} value={id}>{label}</option>;
        })}
      </select>
    </div>
  );
}
