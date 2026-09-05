import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  ArrowUpRight,
  ChartScatter,
  Check,
  CloudDownload,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import {
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  getModelComparison,
  importModelComparison,
  discoverComparisonModels,
  syncArtificialAnalysis,
} from '../../services/apiModelComparison';
import Modal from '../ui/Modal';
import ComparisonResearch from './ComparisonResearch';
import { EFFORT_LADDER, withEstimatedCosts } from '../../lib/effortCostEstimate';

const COLORS = [
  '#2563eb', // blue (GPT-5.6 Sol)
  '#f97316', // orange (GPT-5.6 Terra)
  '#16a34a', // green (GPT-5.6 Luna)
  '#dc2626', // red (GPT-5.5)
  '#9333ea', // purple
  '#0891b2', // cyan
  '#db2777', // pink
  '#ca8a04', // yellow
  '#0d9488', // teal
  '#e11d48', // rose
  '#7c3aed', // violet
  '#059669', // emerald
  '#4f46e5', // indigo
  '#d97706', // amber
  '#475569', // slate
  '#0284c7', // light blue
];

const METRICS = [
  'quality',
  'costPerTask',
  'inputPerMillion',
  'outputPerMillion',
  'reasoningPerMillion',
  'responseSeconds',
  'tokensPerSecond',
  'quota',
];

// Where each effort sits on a model's curve. The ladder itself comes from the
// estimator so the two can't drift; the rest are the model-level configurations
// that are not points on it, plus the aliases the sources use.
const EFFORT_ORDER = {
  'non-reasoning': 0,
  none: 0,
  unspecified: 0.5,
  ...Object.fromEntries(EFFORT_LADDER.map((effort, index) => [effort, index + 1])),
  very_high: EFFORT_LADDER.indexOf('xhigh') + 1,
  reasoning: EFFORT_LADDER.length + 1,
};

const STALE_MS = 30 * 86400000;

function getModelDisplayName(row) {
  if (row.notes) {
    const match = row.notes.match(/Sourced from Artificial Analysis \((.*?)(?:\s*\(.*?\))?\)\./);
    if (match && match[1]) return match[1].trim();
  }
  return row.model;
}

export default function ModelComparison() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const [scenario, setScenario] = useState({ input: 10000, output: 500, reasoning: 0, tasks: 100 });
  const [modelSearch, setModelSearch] = useState('');
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncKey, setSyncKey] = useState('');
  const [syncStatus, setSyncStatus] = useState('');
  const [syncError, setSyncError] = useState('');
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(() => getModelComparison({ silent: true }), []);

  const showEstimates = params.get('estimates') !== '0';
  // Estimating costs walks the whole catalog, and the model filter input below
  // re-renders on every keystroke — memoize so typing doesn't redo the pass.
  const estimatedRows = useMemo(() => {
    const observations = catalog?.observations || [];
    return showEstimates ? withEstimatedCosts(observations) : observations;
  }, [catalog, showEstimates]);
  // Models the user's own providers can dispatch. Everything else in the index
  // is available behind "All models" but is not what the page opens on.
  const availableSet = useMemo(() => new Set(catalog?.availableModels || []), [catalog]);

  useEffect(() => {
    let active = true;
    load()
      .then(data => {
        if (active) setCatalog(data);
      })
      .catch(err => {
        if (active) setError(err.message);
      });
    return () => {
      active = false;
    };
  }, [load]);

  const changeParam = (key, value) =>
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true }
    );

  const toggle = (key, value) =>
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        const values = new Set(next.getAll(key));
        if (values.has(value)) values.delete(value);
        else values.add(value);
        next.delete(key);
        for (const item of values) next.append(key, item);
        return next;
      },
      { replace: true }
    );

  const setAllHidden = (key, valuesToHide) =>
    setParams(
      previous => {
        const next = new URLSearchParams(previous);
        next.delete(key);
        for (const val of valuesToHide) next.append(key, val);
        return next;
      },
      { replace: true }
    );

  const refreshView = () => {
    setBusy(true);
    setError('');
    load()
      .then(setCatalog)
      .catch(err => setError(err.message))
      .finally(() => setBusy(false));
  };

  const discover = providerId => {
    setBusy(true);
    setError('');
    discoverComparisonModels(providerId, { silent: true })
      .then(result => {
        setCatalog(previous => ({
          ...previous,
          inventory: previous.inventory.map(provider =>
            provider.id === providerId ? { ...provider, models: result.models } : provider
          ),
        }));
      })
      .catch(err => setError(err.message))
      .finally(() => setBusy(false));
  };

  const importFile = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 2000000) {
      setError('Catalog file must be smaller than 2 MB.');
      return;
    }
    setBusy(true);
    setError('');
    file
      .text()
      .then(JSON.parse)
      .then(data => importModelComparison(data, { silent: true }))
      .then(data => setCatalog(previous => ({ ...previous, ...data })))
      .catch(err => setError(err.message))
      .finally(() => setBusy(false));
  };

  const handleSyncAA = () => {
    if (!syncKey.trim()) {
      setSyncError('Please enter an Artificial Analysis API key.');
      return;
    }
    setSyncing(true);
    setSyncError('');
    setSyncStatus('Connecting to Artificial Analysis and syncing models…');
    syncArtificialAnalysis({ apiKey: syncKey.trim() }, { silent: true })
      .then(res => {
        setSyncStatus(`Sync successful! Updated ${res.observations} models (${res.total} total).`);
        refreshView();
      })
      .catch(err => {
        setSyncError(err.message || 'Sync failed.');
        setSyncStatus('');
      })
      .finally(() => {
        setSyncing(false);
      });
  };

  if (!catalog) {
    return (
      <div role={error ? 'alert' : 'status'} className="p-6 text-sm text-port-text-muted">
        {error || 'Loading comparison data…'}
        {error && (
          <button
            onClick={refreshView}
            disabled={busy}
            className="ml-3 px-3 py-1 bg-port-card border border-port-border rounded-lg"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  const benchmarks = [...new Set(catalog.observations.map(row => row.benchmark))].sort();
  const benchmark = benchmarks.includes(params.get('benchmark'))
    ? params.get('benchmark')
    : benchmarks.at(-1);
  const mode = params.get('cost') === 'scenario' ? 'scenario' : 'benchmark';
  const showLines = params.get('lines') !== '0';
  const lineStyle = params.get('lineStyle') || 'dotted';
  const showLabels = params.get('labels') === '1' || !params.has('labels');
  // Cost spans four orders of magnitude across the catalog, so a linear axis
  // stacks every affordable model on the y-axis. Log is the readable default.
  const scale = params.get('scale') === 'linear' ? 'linear' : 'log';
  const showAllModels = params.get('allModels') === '1' || availableSet.size === 0;

  // Scope once, then derive every list from the scoped rows — so the provider
  // and effort pills can't offer values that have nothing left to plot.
  const scoped = showAllModels ? estimatedRows : estimatedRows.filter(row => availableSet.has(row.model));
  const models = [...new Set(scoped.map(row => row.model))].sort();
  const providers = [...new Set(scoped.map(row => row.provider))].sort();
  const efforts = [...new Set(scoped.map(row => row.effort))].sort();

  const hidden = {
    provider: new Set(params.getAll('hideProvider')),
    model: new Set(params.getAll('hideModel')),
    effort: new Set(params.getAll('hideEffort')),
  };
  const visible = scoped.filter(
    row =>
      row.benchmark === benchmark &&
      !hidden.provider.has(row.provider) &&
      !hidden.model.has(row.model) &&
      !hidden.effort.has(row.effort)
  );

  const rows = visible.map(row => {
    const cost =
      mode === 'benchmark'
        ? (row.costPerTask?.value ?? row.estimatedCostPerTask?.value)
        : row.billing === 'api' &&
            (scenario.input === 0 || row.inputPerMillion) &&
            (scenario.output === 0 || row.outputPerMillion) &&
            (scenario.reasoning === 0 || row.reasoningPerMillion)
          ? (scenario.input * (row.inputPerMillion?.value || 0) +
              scenario.output * (row.outputPerMillion?.value || 0) +
              scenario.reasoning * (row.reasoningPerMillion?.value || 0)) /
            1000000
          : null;
    const displayName = getModelDisplayName(row);
    return {
      ...row,
      displayName,
      x: cost,
      y: row.quality?.value,
      costEstimated: mode === 'benchmark' && row.costEstimated === true,
      label: `${row.model} (${row.effort})${row.responseSeconds ? ` · ${row.responseSeconds.value}s` : ''}`,
    };
  });

  const plotted = rows.filter(row => Number.isFinite(row.x) && Number.isFinite(row.y) && (scale !== 'log' || row.x > 0));

  // Count models that have 2 or more effort points plotted
  let estimatedCount = 0;
  const multiEffortModelCounts = new Map();
  for (const row of plotted) {
    if (row.costEstimated) estimatedCount += 1;
    multiEffortModelCounts.set(row.model, (multiEffortModelCounts.get(row.model) || 0) + 1);
  }
  const reasoningCurveModels = [...multiEffortModelCounts.entries()]
    .filter(([_, count]) => count >= 2)
    .map(([model]) => model);

  // Filter models for pill toggle display
  const filteredDisplayModels = models.filter(m =>
    !modelSearch || m.toLowerCase().includes(modelSearch.toLowerCase())
  );

  const selectAllModels = () => {
    setAllHidden('hideModel', []);
  };

  const selectReasoningOnly = () => {
    // Keyed on the models that actually PLOT a curve — the same set the button's
    // count names. Counting catalog rows instead would leave models selected
    // that have two efforts but no plottable cost at either.
    setAllHidden('hideModel', models.filter(model => !reasoningCurveModels.includes(model)));
  };

  const clearAllModels = () => {
    setAllHidden('hideModel', models);
  };

  return (
    <div className="space-y-5 min-w-0">
      {/* Header — one compact row: the chart is the page, so the chrome above it
          stays under a single line of text on desktop and never pushes the plot
          below the fold. */}
      <div className="flex flex-wrap justify-between gap-3 items-center">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <ChartScatter size={18} aria-hidden="true" className="shrink-0 text-port-accent-text" />
            Intelligence vs. cost per task
          </h2>
          <p className="text-xs text-port-text-muted mt-0.5">
            Artificial Analysis Intelligence Index against cost per task; labels add end-to-end response time, lines connect reasoning efforts.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-port-card border border-port-border rounded-lg hover:border-port-accent transition-colors"
            onClick={() => setSyncModalOpen(true)}
          >
            <CloudDownload size={14} aria-hidden="true" className="text-port-accent-text" />
            Sync from Artificial Analysis
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-port-card border border-port-border rounded-lg hover:border-port-accent transition-colors"
            onClick={() => changeParam('research', params.get('research') === '1' ? '' : '1')}
            aria-expanded={params.get('research') === '1'}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            Research & schedule
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 px-3 py-1.5 text-xs bg-port-card border border-port-border rounded-lg hover:border-port-accent disabled:opacity-50 transition-colors"
            disabled={busy}
            onClick={refreshView}
          >
            <RefreshCw size={14} aria-hidden="true" className={busy ? 'animate-spin' : ''} />
            Reload data
          </button>
        </div>
      </div>

      {params.get('research') === '1' && <ComparisonResearch />}
      {error && <p role="alert" className="text-port-error">{error}</p>}

      {/* Sync Modal */}
      {/* Modal owns only the backdrop and the panel box; the surface and heading
          are the caller's. Without them the dialog renders transparent. */}
      <Modal
        open={syncModalOpen}
        onClose={() => setSyncModalOpen(false)}
        size="sm"
        ariaLabelledBy="aa-sync-title"
      >
        <div className="bg-port-card border border-port-border rounded-xl shadow-2xl p-5 space-y-4">
          <h3 id="aa-sync-title" className="text-base font-semibold tracking-tight">
            Sync Artificial Analysis data
          </h3>
          <p className="text-xs text-port-text-muted leading-relaxed">
            Fetch the latest benchmark evaluations, pricing, response times, and reasoning effort measurements from the
            Artificial Analysis Free API.
          </p>
          <div className="space-y-1.5">
            <label htmlFor="aa-api-key" className="text-xs font-medium text-port-text-muted">
              Artificial Analysis API Key
            </label>
            <input
              id="aa-api-key"
              type="password"
              placeholder="aa_..."
              aria-label="Artificial Analysis API Key"
              className="w-full bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm font-mono"
              value={syncKey}
              onChange={e => setSyncKey(e.target.value)}
              disabled={syncing}
            />
          </div>
          {syncStatus && <p className="text-xs text-port-accent-text">{syncStatus}</p>}
          {syncError && <p className="text-xs text-port-error">{syncError}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="px-3 py-1.5 text-sm border border-port-border rounded-lg hover:bg-port-bg"
              onClick={() => setSyncModalOpen(false)}
              disabled={syncing}
            >
              Cancel
            </button>
            <button
              type="button"
              className="px-4 py-1.5 text-sm bg-port-accent text-port-on-accent rounded-lg font-medium hover:opacity-90 disabled:opacity-50"
              onClick={handleSyncAA}
              disabled={syncing || !syncKey.trim()}
            >
              {syncing ? 'Syncing…' : 'Start Sync'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Primary Chart Controls Bar */}
      <div className="flex flex-wrap gap-4 items-end bg-port-card border border-port-border rounded-2xl p-4">
        <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-benchmark">
          Benchmark<br />
          <select
            id="comparison-benchmark"
            className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2"
            value={benchmark}
            onChange={e => changeParam('benchmark', e.target.value)}
          >
            {benchmarks.map(value => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>

        <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-cost">
          Cost basis<br />
          <select
            id="comparison-cost"
            className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2"
            value={mode}
            onChange={e => changeParam('cost', e.target.value)}
          >
            <option value="benchmark">Published benchmark cost / task</option>
            <option value="scenario">My token workload estimate</option>
          </select>
        </label>

        <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-scale">
          Cost scale<br />
          <select
            id="comparison-scale"
            className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2"
            value={scale}
            onChange={e => changeParam('scale', e.target.value)}
          >
            <option value="linear">Linear scale</option>
            <option value="log">Logarithmic scale</option>
          </select>
        </label>

        <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-line-style">
          Line style<br />
          <select
            id="comparison-line-style"
            className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2"
            value={lineStyle}
            onChange={e => changeParam('lineStyle', e.target.value)}
            disabled={!showLines}
          >
            <option value="dotted">Dotted</option>
            <option value="dashed">Dashed</option>
            <option value="solid">Solid</option>
          </select>
        </label>

        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted cursor-pointer" htmlFor="comparison-lines">
          <input
            id="comparison-lines"
            type="checkbox"
            className="accent-port-accent size-4 shrink-0"
            checked={showLines}
            onChange={e => changeParam('lines', e.target.checked ? '1' : '0')}
          />
          Connect effort lines
        </label>

        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted cursor-pointer" htmlFor="comparison-labels">
          <input
            id="comparison-labels"
            type="checkbox"
            className="accent-port-accent size-4 shrink-0"
            checked={showLabels}
            onChange={e => changeParam('labels', e.target.checked ? '1' : '0')}
          />
          Point labels
        </label>

        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted cursor-pointer" htmlFor="comparison-estimates">
          <input
            id="comparison-estimates"
            type="checkbox"
            className="accent-port-accent size-4 shrink-0"
            checked={showEstimates}
            onChange={e => changeParam('estimates', e.target.checked ? '1' : '0')}
          />
          Estimate unpublished costs
        </label>

        <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted cursor-pointer" htmlFor="comparison-all-models">
          <input
            id="comparison-all-models"
            type="checkbox"
            className="accent-port-accent size-4 shrink-0"
            checked={showAllModels}
            disabled={availableSet.size === 0}
            onChange={e => changeParam('allModels', e.target.checked ? '1' : '0')}
          />
          All models (not just yours)
        </label>
      </div>

      {/* Scenario Token Inputs */}
      {mode === 'scenario' && (
        <div className="bg-port-card border border-port-border p-4 rounded-2xl space-y-3">
          <div className="flex flex-wrap gap-3">
            {[
              ['input', 'Uncached input tokens'],
              ['output', 'Answer tokens'],
              ['reasoning', 'Reasoning tokens'],
              ['tasks', 'Number of tasks'],
            ].map(([key, label]) => (
              <label key={key} htmlFor={`comparison-${key}`}>
                {label}
                <br />
                <input
                  id={`comparison-${key}`}
                  type="number"
                  min="0"
                  max="1000000000"
                  className="w-36 bg-port-bg border border-port-border p-2 rounded mt-1"
                  value={scenario[key]}
                  onChange={e =>
                    setScenario(previous => ({
                      ...previous,
                      [key]: Math.max(0, Math.min(1e9, Number(e.target.value) || 0)),
                    }))
                  }
                />
              </label>
            ))}
          </div>
          <p className="text-sm text-port-text-muted">
            Estimate uses the entered tokens and published rates. Quality remains the published benchmark score; it does not
            predict quality at this token budget. Include reasoning tokens when applicable. Cache, batch, context-tier
            discounts and taxes are excluded.
          </p>
        </div>
      )}

      {/* Chart Card */}
      <div className="bg-port-card border border-port-border rounded-2xl overflow-hidden">
        <div className="px-4 sm:px-6 pt-5 pb-4 border-b border-port-border space-y-3">
          <div className="flex flex-wrap justify-between items-start gap-3">
            <div>
              <h3 className="font-semibold text-lg tracking-tight">Quality vs. cost</h3>
              <p className="text-xs text-port-text-muted mt-0.5">{benchmark}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-port-bg border border-port-border px-3 py-1 text-xs text-port-text-muted">
                <ArrowUpRight size={14} aria-hidden="true" className="-rotate-90 text-port-accent-text" />
                Prefer higher scores, lower cost
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-port-text-muted">
            <span aria-live="polite">
              {plotted.length} plotted · {rows.length - plotted.length} missing quality or cost
              {reasoningCurveModels.length > 0 ? ` · ${reasoningCurveModels.length} reasoning curves` : ''}
              {estimatedCount > 0 ? ` · ${estimatedCount} estimated cost` : ''}
            </span>

            {/* Quick selection actions */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={selectAllModels}
                className="px-2 py-0.5 rounded border border-port-border hover:border-port-accent hover:text-port-text transition-colors"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={selectReasoningOnly}
                className="px-2 py-0.5 rounded border border-port-border hover:border-port-accent hover:text-port-text transition-colors"
              >
                Reasoning curves ({reasoningCurveModels.length})
              </button>
              <button
                type="button"
                onClick={clearAllModels}
                className="px-2 py-0.5 rounded border border-port-border hover:border-port-accent hover:text-port-text transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          {/* Model Search & Toggle Filter */}
          <div className="space-y-2 pt-1">
            <div className="relative max-w-xs">
              <Search size={13} className="absolute left-2.5 top-2.5 text-port-text-muted" />
              <input
                id="model-filter-search"
                type="text"
                aria-label="Filter models below"
                placeholder="Filter models below…"
                value={modelSearch}
                onChange={e => setModelSearch(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-port-bg border border-port-border rounded-lg"
              />
            </div>

            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto pt-1" aria-label="Toggle chart models">
              {filteredDisplayModels.map((model, index) => {
                const colorIndex = models.indexOf(model);
                const color = COLORS[colorIndex >= 0 ? colorIndex % COLORS.length : index % COLORS.length];
                const selected = !params.getAll('hideModel').includes(model);
                const isCurve = reasoningCurveModels.includes(model);
                return (
                  <button
                    key={model}
                    type="button"
                    aria-pressed={selected}
                    aria-label={`Toggle ${model}`}
                    onClick={() => toggle('hideModel', model)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs transition-colors hover:border-port-accent ${
                      selected
                        ? 'bg-port-bg border-port-border text-port-text'
                        : 'border-transparent text-port-text-muted opacity-50'
                    }`}
                  >
                    <span
                      className="size-3 rounded-full flex items-center justify-center shrink-0"
                      style={{
                        backgroundColor: selected ? color : 'transparent',
                        border: `1.5px solid ${color}`,
                      }}
                    >
                      {selected && <Check size={8} color="#ffffff" aria-hidden="true" />}
                    </span>
                    <span className="font-mono text-[11px]">{model}</span>
                    {isCurve && <span className="text-[10px] text-port-text-muted">({multiEffortModelCounts.get(model)})</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Chart Area */}
        {plotted.length ? (
          <div
            className="h-[380px] sm:h-[480px] px-1 sm:px-4 pt-4"
            role="img"
            aria-label={`Quality versus ${mode === 'benchmark' ? 'benchmark' : 'estimated'} cost per task. Exact values and source links are in the table below.`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 32, right: 24, bottom: 36, left: 10 }}>
                <CartesianGrid strokeDasharray="3 5" stroke="rgb(var(--port-border))" vertical={false} />
                <XAxis
                  tick={{ fill: 'rgb(var(--port-text-muted))', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: 'rgb(var(--port-border))' }}
                  type="number"
                  dataKey="x"
                  name="USD / task"
                  scale={scale === 'log' ? 'log' : 'linear'}
                  domain={scale === 'log' ? ['auto', 'auto'] : [0, 'auto']}
                  tickFormatter={value => `$${value < 0.01 ? value.toFixed(3) : value < 1 ? value.toFixed(2) : value.toFixed(1)}`}
                  label={{
                    value: `Cost per task (USD) — ${scale.toUpperCase()} SCALE`,
                    position: 'bottom',
                    fill: 'rgb(var(--port-text-muted))',
                    fontSize: 12,
                    offset: 10,
                  }}
                />
                <YAxis
                  tick={{ fill: 'rgb(var(--port-text-muted))', fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: 'rgb(var(--port-border))' }}
                  type="number"
                  dataKey="y"
                  name="Benchmark score"
                  domain={['auto', 'auto']}
                  width={55}
                  label={{
                    value: 'Artificial Analysis Intelligence Index',
                    angle: -90,
                    position: 'insideLeft',
                    fill: 'rgb(var(--port-text-muted))',
                    fontSize: 12,
                  }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: '4 4', stroke: 'rgb(var(--port-text-muted))' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.[0]) return null;
                    const item = payload[0].payload;
                    return (
                      <div className="bg-port-card border border-port-border rounded-xl shadow-xl p-3.5 text-xs max-w-72 space-y-1.5 z-50">
                        <div className="flex items-center justify-between gap-2 border-b border-port-border pb-1.5">
                          <span className="font-semibold text-sm text-port-text truncate">{item.displayName || item.model}</span>
                          <span className="px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-[10px] uppercase font-mono text-port-accent-text">
                            {item.effort}
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-port-text-muted">
                          <div>
                            Provider: <span className="text-port-text font-medium">{item.provider}</span>
                          </div>
                          <div>
                            USD / task:{' '}
                            <span className="text-port-text font-semibold">${item.x?.toFixed(4)}</span>
                            {item.costEstimated && <span className="text-port-text-muted"> est.</span>}
                          </div>
                          <div>
                            Index Score: <span className="text-port-accent-text font-bold">{item.y}</span>
                          </div>
                          {item.responseSeconds && (
                            <div>
                              E2E Latency: <span className="text-port-text font-medium">{item.responseSeconds.value}s</span>
                            </div>
                          )}
                          {item.tokensPerSecond && (
                            <div>
                              Speed: <span className="text-port-text font-medium">{item.tokensPerSecond.value} t/s</span>
                            </div>
                          )}
                          {item.inputPerMillion && (
                            <div>
                              In: <span className="text-port-text font-medium">${item.inputPerMillion.value}/1M</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }}
                />
                {models.map((model, index) => {
                  const modelData = plotted
                    .filter(row => row.model === model)
                    .sort(
                      (a, b) =>
                        (EFFORT_ORDER[a.effort] ?? 99) - (EFFORT_ORDER[b.effort] ?? 99) || (a.x - b.x)
                    );
                  if (!modelData.length) return null;
                  const color = COLORS[index % COLORS.length];
                  const hasLine = showLines && modelData.length > 1;

                  return (
                    <Scatter
                      key={model}
                      name={model}
                      isAnimationActive={false}
                      data={modelData}
                      fill={color}
                      line={
                        hasLine
                          ? {
                              stroke: color,
                              strokeDasharray:
                                lineStyle === 'dotted' ? '3 3' : lineStyle === 'dashed' ? '6 4' : undefined,
                              strokeWidth: 2,
                            }
                          : false
                      }
                      // A hollow marker means the cost came from the effort-ratio
                      // estimate, not from a published cost per task.
                      shape={({ cx, cy, fill, payload }) => (
                        <g>
                          <circle cx={cx} cy={cy} r={9} fill={fill} fillOpacity={0.16} stroke="none" />
                          <circle
                            cx={cx}
                            cy={cy}
                            r={5}
                            fill={payload?.costEstimated ? 'rgb(var(--port-card))' : fill}
                            stroke={payload?.costEstimated ? fill : 'rgb(var(--port-card))'}
                            strokeWidth={payload?.costEstimated ? 2 : 1.5}
                          />
                        </g>
                      )}
                    >
                      {showLabels && (
                        <LabelList
                          dataKey="label"
                          position="top"
                          content={labelProps => {
                            const { x, y, index: ptIdx } = labelProps;
                            const pt = modelData[ptIdx];
                            if (!pt) return null;
                            const shortName = pt.displayName || pt.model;
                            const effortLabel = pt.effort && pt.effort !== 'unspecified' ? pt.effort : '';
                            const e2eStr = pt.responseSeconds?.value ? `${pt.responseSeconds.value} s E2E` : '';
                            return (
                              <g transform={`translate(${x}, ${y - 12})`} className="pointer-events-none select-none">
                                <text textAnchor="middle" className="text-[10px] fill-port-text font-medium">
                                  {effortLabel ? `${shortName} (${effortLabel})` : shortName}
                                </text>
                                {e2eStr && (
                                  <text textAnchor="middle" dy="11" className="text-[9px] fill-port-text-muted">
                                    {e2eStr}
                                  </text>
                                )}
                              </g>
                            );
                          }}
                        />
                      )}
                    </Scatter>
                  );
                })}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="py-12 text-center text-port-text-muted">
            No comparable points for these filters. Adjust filters or refresh the research catalog.
          </p>
        )}
        <p className="text-xs leading-relaxed text-port-text-muted border-t border-port-border px-4 sm:px-6 py-4">
          Response-time labels reflect measured source workloads, independent of the intelligence evaluation. Connected lines
          link the same model family across reasoning efforts (ordered from low to max). Hollow markers are estimated costs:
          Artificial Analysis publishes cost per task for only one effort of most models, so the remaining efforts are scaled
          from that model&apos;s published anchor using the effort-cost curve measured across the models that do publish a full
          set. Turn them off with &ldquo;Estimate unpublished costs&rdquo;.
        </p>
      </div>

      {/* Filters Accordion */}
      <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm">
        <summary className="cursor-pointer font-medium">Show or hide providers, models & effort</summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mt-3">
          {[
            ['Providers', 'hideProvider', providers],
            ['Models', 'hideModel', models],
            ['Effort', 'hideEffort', efforts],
          ].map(([title, key, values]) => (
            <fieldset key={key} className="max-h-48 overflow-auto space-y-1">
              <legend className="font-semibold">{title}</legend>
              {values.map(value => (
                <label htmlFor={`${key}-${encodeURIComponent(value)}`} key={value} className="flex items-center gap-2 py-1">
                  <input
                    id={`${key}-${encodeURIComponent(value)}`}
                    type="checkbox"
                    className="accent-port-accent size-4 shrink-0"
                    checked={!params.getAll(key).includes(value)}
                    onChange={() => toggle(key, value)}
                  />
                  {value}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </details>

      {/* Evidence Table */}
      <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm">
        <summary className="cursor-pointer font-semibold">Evidence & sources ({rows.length} configurations)</summary>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <caption className="text-left font-semibold py-2">Evidence and estimates</caption>
            <thead className="text-xs text-port-text-muted bg-port-bg">
              <tr>
                {[
                  'Provider / model / effort',
                  'Quality',
                  'USD / task',
                  'Scenario total',
                  'Response / speed',
                  'Quota',
                  'Sources & freshness',
                ].map(label => (
                  <th className="p-3" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className="border-t border-port-border align-top hover:bg-port-bg/50">
                  <td className="p-3">
                    <strong>
                      {row.provider} · {row.displayName || row.model} ({row.effort})
                    </strong>
                    <p>
                      {row.billing} · {row.configuration}
                    </p>
                    <p className="text-port-text-muted">{row.notes}</p>
                  </td>
                  <td className="p-3">{row.y ?? 'Unknown'}</td>
                  <td className="p-3">{Number.isFinite(row.x) ? `$${row.x.toFixed(4)}` : 'Unknown'}</td>
                  <td className="p-3">
                    {mode === 'scenario' && Number.isFinite(row.x) ? `$${(row.x * scenario.tasks).toFixed(2)}` : '—'}
                  </td>
                  <td className="p-3">
                    {row.responseSeconds ? `${row.responseSeconds.value}s E2E` : 'E2E unknown'}
                    <br />
                    {row.tokensPerSecond ? `${row.tokensPerSecond.value} tok/s` : 'Speed unknown'}
                  </td>
                  <td className="p-3">
                    {row.quota
                      ? `${row.quota.unitsPerTask} ${row.quota.unit}/task${mode === 'scenario' ? ` · ${row.quota.unitsPerTask * scenario.tasks} total` : ''}`
                      : 'Unknown'}
                  </td>
                  <td className="p-2 min-w-56">
                    {METRICS.filter(key => row[key]).map(key => (
                      <p key={key} className="mb-2">
                        <a className="text-port-accent-text underline" href={row[key].source.url} target="_blank" rel="noreferrer">
                          {key}
                        </a>{' '}
                        · {row[key].source.retrievedAt.slice(0, 10)}
                        {Date.now() - Date.parse(row[key].source.retrievedAt) > STALE_MS && <strong> · Stale</strong>}
                        <br />
                        <span className="text-port-text-muted">{row[key].source.methodology}</span>
                      </p>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {/* Provider Coverage */}
      <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm">
        <summary>Configured provider coverage ({catalog.inventory?.length || 0} providers)</summary>
        <p className="text-sm text-port-text-muted my-2">
          Model-name matches are references only, not measurements of this endpoint. Quantization, local hardware, harnesses
          and billing may differ. Refresh model lists in{' '}
          <Link className="text-port-accent-text underline" to="/models/harnesses">
            Harnesses
          </Link>{' '}
          or{' '}
          <Link className="text-port-accent-text underline" to="/models/llms/library">
            LLMs
          </Link>
          , then reload here.
        </p>
        {catalog.inventory?.map(provider => (
          <div key={provider.id} className="my-3">
            <strong>{provider.name}</strong>
            {provider.canDiscover && (
              <button className="ml-3 underline text-port-accent-text" disabled={busy} onClick={() => discover(provider.id)}>
                Discover current models
              </button>
            )}
            <ul>
              {provider.models.map(({ model, efforts: supported }) => (
                <li key={model}>
                  {model} {supported.length ? `(${supported.join(', ')})` : ''} —{' '}
                  {catalog.observations.some(row => row.model === model)
                    ? 'Public model reference available; endpoint equivalence unverified'
                    : 'Needs research'}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </details>

      {/* Import Sourced Observations */}
      <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm">
        <summary>Import sourced observations</summary>
        <p className="text-sm my-2">
          Import a version 1 catalog following docs/MODEL-COMPARISON.md. Valid observations merge by stable ID; missing or older
          metrics preserve existing evidence.
        </p>
        <label htmlFor="comparison-import">Catalog JSON</label>
        <input
          id="comparison-import"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={importFile}
          className="block my-2"
        />
      </details>

      <p className="text-xs text-port-text-muted">
        Benchmark attribution:{' '}
        <a className="underline" href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">
          Artificial Analysis
        </a>
        . Source-specific methodologies appear above. Entries older than 30 days are marked stale.
      </p>
    </div>
  );
}
