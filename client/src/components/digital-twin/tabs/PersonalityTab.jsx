import { useState, useEffect, useMemo } from 'react';
import {
  Play,
  Brain,
  History,
  Trash2,
  ChevronDown,
  ChevronRight,
  Settings,
  AlertCircle,
  GitCompareArrows
} from 'lucide-react';
import {
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Legend, Tooltip, ResponsiveContainer
} from 'recharts';
import BrailleSpinner from '../../BrailleSpinner';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import useChartColors from '../../../hooks/useChartColors.js';
import { timeAgo, formatDateShort } from '../../../utils/formatters';
import { filterSelectableModels } from '../../../utils/providers.js';

// "errorAversion" → "Error Aversion"
const humanizeTrait = (key) =>
  key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

// Union of trait keys across runs — taxonomy versions may differ per record.
const traitKeyUnion = (runs) => [...new Set(runs.flatMap((r) => Object.keys(r.traits || {})))];

// Unique, readable series label for a run on the radar/table.
const seriesLabel = (run) => `${run.model || run.providerId} · ${formatDateShort(run.timestamp)}`;

const alignmentColor = (score) =>
  score >= 0.7 ? 'text-port-success' : score >= 0.4 ? 'text-port-warning' : 'text-port-error';

function TraitRadar({ runs, height = 320 }) {
  const colors = useChartColors();
  // Keys can differ across taxonomy versions — chart the union.
  const { data, labels } = useMemo(() => {
    const keys = traitKeyUnion(runs);
    const bases = runs.map(seriesLabel);
    const labels = bases.map((base, i) => (bases.indexOf(base) === i ? base : `${base} (${i + 1})`));
    const data = keys.map((k) => {
      const row = { trait: humanizeTrait(k) };
      runs.forEach((r, i) => {
        const score = r.traits?.[k]?.score;
        row[labels[i]] = score != null ? Math.round(score * 100) : null;
      });
      return row;
    });
    return { data, labels };
  }, [runs]);

  const palette = [colors.chart1, colors.chart2, colors.chart3, colors.chart4, colors.warning, colors.error];

  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadarChart data={data} outerRadius="70%">
        <PolarGrid stroke={colors.grid} />
        <PolarAngleAxis dataKey="trait" tick={{ fill: colors.axis, fontSize: 11 }} />
        <PolarRadiusAxis domain={[0, 100]} tick={{ fill: colors.axis, fontSize: 10 }} />
        {runs.map((r, i) => (
          <Radar
            key={r.runId}
            name={labels[i]}
            dataKey={labels[i]}
            stroke={palette[i % palette.length]}
            fill={palette[i % palette.length]}
            fillOpacity={0.15}
          />
        ))}
        <Tooltip
          contentStyle={{
            background: colors.tooltipBg,
            border: `1px solid ${colors.tooltipBorder}`,
            borderRadius: 6,
            fontSize: 12
          }}
          labelStyle={{ color: colors.text }}
        />
        {runs.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
      </RadarChart>
    </ResponsiveContainer>
  );
}

function AlignmentSection({ run }) {
  if (run.alignmentSkipped) {
    return (
      <div className="flex items-start gap-2 p-3 rounded bg-port-warning/10 text-port-warning text-sm">
        <AlertCircle size={16} className="shrink-0 mt-0.5" />
        <span>Alignment check skipped: {run.alignmentSkipped}</span>
      </div>
    );
  }
  if (!run.alignment) return null;
  const dims = Object.entries(run.alignment.dimensions || {});
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-gray-400">Twin alignment</span>
        <span className={`text-2xl font-bold ${alignmentColor(run.alignment.alignmentScore)}`}>
          {Math.round(run.alignment.alignmentScore * 100)}%
        </span>
        {run.scorerModel && (
          <span className="text-xs text-gray-500">scored by {run.scorerModel}</span>
        )}
      </div>
      {dims.length > 0 && (
        <ul className="space-y-1">
          {dims.map(([dim, d]) => (
            <li key={dim} className="text-sm flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-2">
              <span className={`font-medium shrink-0 ${alignmentColor(d.score)}`}>
                {humanizeTrait(dim)} {Math.round(d.score * 100)}%
              </span>
              {d.note && <span className="text-gray-400">{d.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RunDetail({ run }) {
  // Stable array identity so TraitRadar's useMemo caches across parent re-renders.
  const runs = useMemo(() => [run], [run]);
  return (
    <div className="space-y-4">
      <TraitRadar runs={runs} />
      {run.summary && (
        <p className="text-sm text-gray-300 bg-port-bg p-3 rounded whitespace-pre-wrap">{run.summary}</p>
      )}
      <AlignmentSection run={run} />
      <div>
        <h4 className="text-sm font-medium text-gray-400 mb-2">Per-trait self-observations</h4>
        <ul className="space-y-2">
          {Object.entries(run.traits || {}).map(([key, t]) => (
            <li key={key} className="text-sm">
              <span className="text-white font-medium">{humanizeTrait(key)}</span>
              <span className="text-port-accent ml-2">{Math.round((t.score ?? 0) * 100)}%</span>
              {t.rationale && <p className="text-gray-400">{t.rationale}</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function PersonalityTab() {
  const [providers, setProviders] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  // Run configuration
  const [selectedProviders, setSelectedProviders] = useState([]);
  const [includeAlignment, setIncludeAlignment] = useState(true);
  const [running, setRunning] = useState(null); // { current, total, model } | null

  // Results & views
  const [results, setResults] = useState([]);
  const [expandedRunId, setExpandedRunId] = useState(null);
  const [compareIds, setCompareIds] = useState([]);

  // Options panel
  const [showOptions, setShowOptions] = useState(false);
  const [scorerProviderId, setScorerProviderId] = useState('');
  const [scorerModel, setScorerModel] = useState('');
  const [historyCap, setHistoryCap] = useState(200);
  const [savingSettings, setSavingSettings] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    const [providersData, historyData, settingsData] = await Promise.all([
      api.getProviders({ silent: true }).catch(() => ({ providers: [] })),
      api.getModelPersonalityHistory(50, { silent: true }).catch(() => []),
      api.getModelPersonalitySettings({ silent: true }).catch(() => null)
    ]);
    setProviders((providersData.providers || []).filter((p) => p.enabled));
    setHistory(Array.isArray(historyData) ? historyData : []);
    if (settingsData) {
      setIncludeAlignment(settingsData.defaultIncludeAlignment ?? true);
      setScorerProviderId(settingsData.scorerProviderId || '');
      setScorerModel(settingsData.scorerModel || '');
      setHistoryCap(settingsData.historyCap ?? 200);
    }
    setLoading(false);
  };

  const toggleProvider = (providerId, model) => {
    const key = `${providerId}:${model}`;
    setSelectedProviders((prev) =>
      prev.some((p) => `${p.providerId}:${p.model}` === key)
        ? prev.filter((p) => `${p.providerId}:${p.model}` !== key)
        : [...prev, { providerId, model }]
    );
  };

  const runTest = async () => {
    if (selectedProviders.length === 0) {
      toast.error('Select at least one provider/model');
      return;
    }
    setResults([]);
    // Sequential execution per model with progress; each result lands reactively.
    for (let i = 0; i < selectedProviders.length; i++) {
      const { providerId, model } = selectedProviders[i];
      setRunning({ current: i + 1, total: selectedProviders.length, model });
      // The api helper toasts the error; a failed model doesn't abort the rest.
      const record = await api
        .runModelPersonalityTest({ providerId, model, includeAlignment })
        .catch(() => null);
      if (record) {
        setResults((prev) => [...prev, record]);
        setHistory((prev) => [record, ...prev]);
        setExpandedRunId(record.runId);
      }
    }
    setRunning(null);
  };

  const deleteRun = async (runId) => {
    const ok = await api
      .deleteModelPersonalityResult(runId)
      .then(() => true)
      .catch(() => false);
    if (!ok) return;
    setHistory((prev) => prev.filter((r) => r.runId !== runId));
    setResults((prev) => prev.filter((r) => r.runId !== runId));
    setCompareIds((prev) => prev.filter((id) => id !== runId));
    if (expandedRunId === runId) setExpandedRunId(null);
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    const saved = await api
      .updateModelPersonalitySettings({
        scorerProviderId: scorerProviderId || null,
        scorerModel: scorerModel || null,
        historyCap: Number(historyCap) || 200,
        defaultIncludeAlignment: includeAlignment
      })
      .catch(() => null);
    setSavingSettings(false);
    if (saved) toast.success('Personality test settings saved');
  };

  const toggleCompare = (runId) => {
    setCompareIds((prev) =>
      prev.includes(runId) ? prev.filter((id) => id !== runId) : [...prev, runId]
    );
  };

  const compareRuns = useMemo(
    () => history.filter((r) => compareIds.includes(r.runId)),
    [history, compareIds]
  );
  const compareTraitKeys = useMemo(() => traitKeyUnion(compareRuns), [compareRuns]);

  const scorerProvider = providers.find((p) => p.id === scorerProviderId);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Intro */}
      <div className="flex items-start gap-3">
        <Brain className="w-6 h-6 text-port-accent shrink-0 mt-0.5" />
        <p className="text-sm text-gray-400">
          Ask a model to run a deep introspective self-evaluation and return a structured personality
          profile — agreeableness, humor, sycophancy, self-censorship and more — then optionally score
          how well that posture aligns with your digital twin. One LLM call per model (two with the
          alignment check), fired only when you press Run.
        </p>
      </div>

      {/* Provider selection */}
      <div className="bg-port-card rounded-lg border border-port-border p-4">
        <h3 className="font-semibold text-white mb-4">Select Providers & Models</h3>
        <div className="space-y-3 max-h-64 overflow-y-auto">
          {providers.length === 0 && (
            <p className="text-sm text-gray-500">No enabled AI providers. Configure one in Settings → AI Providers.</p>
          )}
          {providers.map((provider) => (
            <div key={provider.id} className="space-y-2">
              <div className="text-sm font-medium text-gray-400">{provider.name}</div>
              <div className="flex flex-wrap gap-2">
                {filterSelectableModels(
                  provider.models?.length ? provider.models : [provider.defaultModel]
                ).filter(Boolean).map((model) => {
                  const isSelected = selectedProviders.some(
                    (p) => p.providerId === provider.id && p.model === model
                  );
                  return (
                    <button
                      key={model}
                      onClick={() => toggleProvider(provider.id, model)}
                      className={`px-3 py-2 min-h-[40px] text-sm rounded-lg border transition-colors ${
                        isSelected
                          ? 'bg-port-accent/20 border-port-accent text-port-accent'
                          : 'border-port-border text-gray-400 hover:text-white hover:border-gray-500'
                      }`}
                    >
                      {model}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Run controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
        <button
          onClick={runTest}
          disabled={!!running || selectedProviders.length === 0}
          className="flex items-center justify-center gap-2 px-6 py-3 min-h-[48px] bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? (
            <>
              <BrailleSpinner />
              Testing {running.model} ({running.current}/{running.total})...
            </>
          ) : (
            <>
              <Play className="w-5 h-5" />
              Run Personality Test
            </>
          )}
        </button>

        <label className="flex items-center gap-2 min-h-[44px] cursor-pointer text-sm text-gray-300">
          <input
            type="checkbox"
            checked={includeAlignment}
            onChange={(e) => setIncludeAlignment(e.target.checked)}
            className="w-5 h-5 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
          />
          Include twin alignment check
        </label>

        <button
          onClick={() => setShowOptions((v) => !v)}
          className="flex items-center justify-center gap-2 px-4 py-3 min-h-[44px] text-sm text-gray-400 border border-port-border rounded-lg hover:text-white hover:border-gray-500"
        >
          <Settings size={16} />
          Options
        </button>
      </div>

      {/* Options */}
      {showOptions && (
        <div className="bg-port-card rounded-lg border border-port-border p-4 space-y-4">
          <h3 className="font-semibold text-white">Options</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label htmlFor="personality-scorer-provider" className="block text-sm text-gray-400 mb-1">
                Alignment scorer provider
              </label>
              <select
                id="personality-scorer-provider"
                value={scorerProviderId}
                onChange={(e) => { setScorerProviderId(e.target.value); setScorerModel(''); }}
                className="w-full px-3 py-2 min-h-[40px] text-sm rounded-lg border border-port-border bg-port-bg text-white focus:ring-port-accent focus:border-port-accent"
              >
                <option value="">Same as tested provider</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="personality-scorer-model" className="block text-sm text-gray-400 mb-1">
                Scorer model
              </label>
              <select
                id="personality-scorer-model"
                value={scorerModel}
                onChange={(e) => setScorerModel(e.target.value)}
                disabled={!scorerProvider}
                className="w-full px-3 py-2 min-h-[40px] text-sm rounded-lg border border-port-border bg-port-bg text-white focus:ring-port-accent focus:border-port-accent disabled:opacity-50"
              >
                <option value="">Provider default</option>
                {filterSelectableModels(scorerProvider?.models).map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="personality-history-cap" className="block text-sm text-gray-400 mb-1">
                History cap
              </label>
              <input
                id="personality-history-cap"
                type="number"
                min={1}
                max={1000}
                value={historyCap}
                onChange={(e) => setHistoryCap(e.target.value)}
                className="w-full px-3 py-2 min-h-[40px] text-sm rounded-lg border border-port-border bg-port-bg text-white focus:ring-port-accent focus:border-port-accent"
              />
            </div>
          </div>
          <button
            onClick={saveSettings}
            disabled={savingSettings}
            className="px-4 py-2 min-h-[40px] text-sm bg-port-accent text-white rounded-lg font-medium hover:bg-port-accent/80 disabled:opacity-50"
          >
            {savingSettings ? 'Saving...' : 'Save Options'}
          </button>
        </div>
      )}

      {/* Fresh results */}
      {results.length > 0 && (
        <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
          <div className="p-4 border-b border-port-border">
            <h3 className="font-semibold text-white">Results</h3>
          </div>
          <div className="p-4 space-y-6">
            {results.map((run) => (
              <div key={run.runId} className="space-y-2">
                <div className="text-sm font-medium text-white">{seriesLabel(run)}</div>
                <RunDetail run={run} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Compare view */}
      {compareRuns.length >= 2 && (
        <div className="bg-port-card rounded-lg border border-port-border overflow-hidden">
          <div className="p-4 border-b border-port-border flex items-center gap-2">
            <GitCompareArrows size={18} className="text-port-accent" />
            <h3 className="font-semibold text-white">Compare ({compareRuns.length} runs)</h3>
          </div>
          <div className="p-4 space-y-4">
            <TraitRadar runs={compareRuns} height={360} />
            <div className="overflow-x-auto -mx-4 sm:mx-0">
              <table className="w-full min-w-[480px]">
                <thead>
                  <tr className="border-b border-port-border">
                    <th className="px-4 py-2 text-left text-sm font-medium text-gray-400">Trait</th>
                    {compareRuns.map((r) => (
                      <th key={r.runId} className="px-4 py-2 text-left text-sm font-medium text-gray-400">
                        {seriesLabel(r)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {compareTraitKeys.map((key) => (
                    <tr key={key} className="border-b border-port-border last:border-b-0">
                      <td className="px-4 py-2 text-sm text-white">{humanizeTrait(key)}</td>
                      {compareRuns.map((r) => {
                        const score = r.traits?.[key]?.score;
                        return (
                          <td key={r.runId} className="px-4 py-2 text-sm text-port-accent">
                            {score != null ? `${Math.round(score * 100)}%` : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="bg-port-border/30">
                    <td className="px-4 py-2 text-sm font-medium text-white">Twin alignment</td>
                    {compareRuns.map((r) => (
                      <td key={r.runId} className="px-4 py-2 text-sm">
                        {r.alignment ? (
                          <span className={`font-bold ${alignmentColor(r.alignment.alignmentScore)}`}>
                            {Math.round(r.alignment.alignmentScore * 100)}%
                          </span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      {history.length > 0 && (
        <div className="bg-port-card rounded-lg border border-port-border p-4">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-semibold text-white flex items-center gap-2">
              <History size={18} />
              Past Runs
            </h3>
            <span className="text-xs text-gray-500">Select 2+ to compare</span>
          </div>
          <div className="space-y-2 mt-3">
            {history.map((run) => (
              <div key={run.runId} className="rounded bg-port-bg">
                <div className="flex items-center gap-3 p-3">
                  <input
                    type="checkbox"
                    checked={compareIds.includes(run.runId)}
                    onChange={() => toggleCompare(run.runId)}
                    aria-label={`Compare ${seriesLabel(run)}`}
                    className="w-5 h-5 rounded border-port-border bg-port-card text-port-accent focus:ring-port-accent"
                  />
                  <button
                    onClick={() => setExpandedRunId(expandedRunId === run.runId ? null : run.runId)}
                    className="flex-1 flex items-center gap-2 text-left min-h-[40px]"
                  >
                    {expandedRunId === run.runId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <div className="min-w-0">
                      <div className="text-sm text-white truncate">{run.model || run.providerId}</div>
                      <div className="text-xs text-gray-500">{timeAgo(run.timestamp)}</div>
                    </div>
                  </button>
                  {run.alignment && (
                    <span className={`text-sm font-bold shrink-0 ${alignmentColor(run.alignment.alignmentScore)}`}>
                      {Math.round(run.alignment.alignmentScore * 100)}%
                    </span>
                  )}
                  <button
                    onClick={() => deleteRun(run.runId)}
                    aria-label={`Delete ${seriesLabel(run)}`}
                    className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-500 hover:text-port-error"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                {expandedRunId === run.runId && (
                  <div className="p-3 pt-0 border-t border-port-border">
                    <RunDetail run={run} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
