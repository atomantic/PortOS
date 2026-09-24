import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Play, RefreshCw, Search, Square } from 'lucide-react';
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  discoverModelPerformanceModels,
  getModelPerformanceBenchmarks,
  runModelPerformanceBenchmark,
} from '../../services/apiModelPerformance';
import { formatCount, formatUsd } from '../../utils/formatters';
import toast from '../ui/Toast';

const BENCHMARK_NAME = 'PortOS Task Bench v1 (deterministic)';
const COLORS = ['#2563eb', '#f97316', '#16a34a', '#9333ea', '#0891b2', '#db2777', '#ca8a04'];

const sourceDate = row => row.quality?.source?.retrievedAt || row.tokensPerRun?.source?.retrievedAt || '';

function BenchmarkTooltip({ active, payload }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border border-port-border bg-port-card p-3 text-sm shadow-lg">
      <div className="font-semibold">{row.model}</div>
      <div className="text-port-text-muted">{row.provider} · {row.effort}</div>
      <div>{formatCount(row.y)}% score</div>
      <div>{formatCount(row.tokensPerRun.value)} tokens per run</div>
      {row.apiEquivalentCost && <div>~{formatUsd(row.apiEquivalentCost.value * 1000)} API equivalent / 1,000 runs</div>}
      <div className="text-port-text-muted">{row.tokenBasis || 'token basis unavailable'}</div>
    </div>
  );
}

export default function PortosModelBenchmarkPanel() {
  const [catalog, setCatalog] = useState(null);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [chartMetric, setChartMetric] = useState('tokens');
  const [discovering, setDiscovering] = useState(false);
  const [running, setRunning] = useState(false);
  const busy = discovering || running;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const runController = useRef(null);
  const cancelled = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    getModelPerformanceBenchmarks({ silent: true })
      .then(setCatalog)
      .catch(err => setError(err.message || 'Could not load PortOS benchmark data.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    return () => runController.current?.abort();
  }, [load]);

  const inventory = catalog?.inventory || [];
  const selectedProvider = inventory.find(provider => provider.id === providerId) || null;
  const models = selectedProvider?.models || [];
  const selectedModel = models.find(entry => entry.model === model) || null;
  const efforts = selectedModel?.efforts || [];

  useEffect(() => {
    if (!inventory.length) return;
    const activeProvider = inventory.find(provider => provider.id === providerId) || inventory[0];
    if (activeProvider.id !== providerId) {
      setProviderId(activeProvider.id);
      return;
    }
    if (!activeProvider.models.some(entry => entry.model === model)) setModel(activeProvider.models[0]?.model || '');
  }, [inventory, model, providerId]);

  useEffect(() => {
    if (effort && !efforts.includes(effort)) setEffort('');
  }, [effort, efforts]);

  const observations = useMemo(
    () => (catalog?.observations || [])
      .filter(row => row.benchmark === BENCHMARK_NAME)
      .sort((a, b) => sourceDate(b).localeCompare(sourceDate(a))),
    [catalog],
  );
  const plotted = useMemo(() => observations
    .filter(row => row.quality && (chartMetric === 'tokens' ? row.tokensPerRun : row.apiEquivalentCost))
    .map(row => ({
      ...row,
      x: chartMetric === 'tokens' ? row.tokensPerRun.value : row.apiEquivalentCost.value * 1000,
      y: row.quality.value,
    })), [chartMetric, observations]);
  const grouped = useMemo(() => {
    const providers = [...new Set(plotted.map(row => row.provider))];
    return providers.map((name, index) => ({
      name,
      color: COLORS[index % COLORS.length],
      rows: plotted.filter(row => row.provider === name),
    }));
  }, [plotted]);

  const discover = () => {
    if (!selectedProvider?.canDiscover) return;
    setDiscovering(true);
    setError('');
    discoverModelPerformanceModels(selectedProvider.id, { silent: true })
      .then(result => {
        setCatalog(previous => ({
          ...previous,
          inventory: previous.inventory.map(provider => provider.id === result.providerId
            ? { ...provider, models: result.models }
            : provider),
        }));
      })
      .catch(err => setError(err.message || 'Model discovery failed.'))
      .finally(() => setDiscovering(false));
  };

  const startBenchmark = () => {
    if (!selectedProvider?.canBenchmark || !model || busy) return;
    const controller = new AbortController();
    cancelled.current = false;
    runController.current = controller;
    setRunning(true);
    setError('');
    setStatus(`Running five short tasks on ${model}${effort ? ` at ${effort} effort` : ''}…`);
    runModelPerformanceBenchmark({ providerId, model, effort: effort || null }, { signal: controller.signal, silent: true })
      .then(result => {
        setCatalog(previous => ({
          ...previous,
          observations: [...(previous?.observations || []).filter(row => row.id !== result.observation.id), result.observation],
        }));
        if (result.complete) {
          toast.success(`Benchmark saved: ${formatCount(result.observation.quality.value)}% correct`);
        } else {
          const reason = result.failureReason ? ` ${result.failureReason}.` : '';
          setStatus(`Partial benchmark saved: ${result.observation.completedTasks}/${result.observation.totalTasks} tasks; no score assigned.${reason}`);
          toast.warning(`Partial benchmark saved: ${result.observation.completedTasks}/${result.observation.totalTasks} tasks; no score assigned.${reason}`);
        }
      })
      .catch(err => {
        if (cancelled.current) {
          setError('Run cancelled. Use Refresh to check for a saved partial usage record.');
          getModelPerformanceBenchmarks({ silent: true }).then(setCatalog).catch(() => {});
          return;
        }
        setError(err.message || 'Benchmark run failed.');
      })
      .finally(() => {
        runController.current = null;
        setRunning(false);
        setStatus('');
      });
  };

  const stopBenchmark = () => {
    cancelled.current = true;
    runController.current?.abort();
  };

  if (loading && !catalog) {
    return <div role="status" className="p-6 text-sm text-port-text-muted">Loading PortOS benchmark data…</div>;
  }

  return (
    <div className="min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold"><Activity size={22} /> PortOS task benchmark</h2>
          <p className="mt-1 max-w-3xl text-sm text-port-text-muted">
            PortOS runs the same deterministic tasks on models this install can use. Results stay on this machine.
          </p>
        </div>
        <button type="button" onClick={load} disabled={loading || busy} className="inline-flex items-center gap-2 rounded-lg border border-port-border bg-port-card px-3 py-2 text-sm disabled:opacity-50">
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </header>

      <section className="rounded-xl border border-port-border bg-port-card p-4 md:p-5">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Run a PortOS benchmark</h2>
          <p className="mt-1 text-sm text-port-text-muted">
            One run makes five sequential provider calls. PortOS scores exact answers and stores token counts, timing and the score; it never stores prompts or model responses.
          </p>
        </div>
        {inventory.length === 0 ? (
          <div className="rounded-lg border border-dashed border-port-border p-4 text-sm text-port-text-muted">
            No enabled subscription or free providers are available to benchmark.
          </div>
        ) : (
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-2 xl:grid-cols-[minmax(14rem,1fr)_minmax(14rem,1fr)_12rem_auto_auto]">
            <div>
              <label htmlFor="benchmark-provider" className="mb-1 block text-sm font-medium">Provider</label>
              <select id="benchmark-provider" value={providerId} onChange={event => { setProviderId(event.target.value); setModel(''); setEffort(''); }} disabled={busy} className="w-full rounded-lg border border-port-border bg-port-bg px-3 py-2">
                {inventory.map(provider => <option key={provider.id} value={provider.id}>{provider.name || provider.id} · {provider.billing}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="benchmark-model" className="mb-1 block text-sm font-medium">Model</label>
              <select id="benchmark-model" value={model} onChange={event => { setModel(event.target.value); setEffort(''); }} disabled={busy || models.length === 0} className="w-full rounded-lg border border-port-border bg-port-bg px-3 py-2">
                {models.length === 0 && <option value="">No discovered models</option>}
                {models.map(entry => <option key={entry.model} value={entry.model}>{entry.model}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="benchmark-effort" className="mb-1 block text-sm font-medium">Reasoning effort</label>
              <select id="benchmark-effort" value={effort} onChange={event => setEffort(event.target.value)} disabled={busy || efforts.length === 0} className="w-full rounded-lg border border-port-border bg-port-bg px-3 py-2">
                <option value="">Provider default</option>
                {efforts.map(value => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            {selectedProvider?.canDiscover && (
              <button type="button" onClick={discover} disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm disabled:opacity-50">
                <Search size={16} /> Discover models
              </button>
            )}
            {running ? (
              <button type="button" onClick={stopBenchmark} className="inline-flex items-center justify-center gap-2 rounded-lg bg-port-error px-4 py-2 font-medium text-white">
                <Square size={15} /> Stop
              </button>
            ) : (
              <button type="button" onClick={startBenchmark} disabled={!selectedProvider?.canBenchmark || !model || busy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-port-accent px-4 py-2 font-medium text-white disabled:opacity-50">
                <Play size={16} /> Run five tasks
              </button>
            )}
          </div>
        )}
        {selectedProvider && !selectedProvider.canBenchmark && <p className="mt-3 text-sm text-port-warning">{selectedProvider.benchmarkUnavailableReason}</p>}
        {selectedProvider && models.length === 0 && selectedProvider.canDiscover && <p className="mt-3 text-sm text-port-text-muted">Discover installed or advertised models for this provider to enable a run.</p>}
        <p className="mt-3 text-xs text-port-text-muted">
          Subscription allowance use is not measurable per task. API-equivalent dollars are reference estimates only. Local providers use measured tokens when reported, otherwise a characters ÷ 4 estimate.
        </p>
        {status && <p role="status" className="mt-3 text-sm text-port-accent">{status}</p>}
        {error && <p role="alert" className="mt-3 text-sm text-port-error">{error}</p>}
      </section>

      <section className="rounded-xl border border-port-border bg-port-card p-4 md:p-5">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold">Usage or cost vs. task performance</h2>
            <p className="text-sm text-port-text-muted">Each point is one completed five-task run. Higher score and lower usage or cost are better.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-port-border p-1" role="group" aria-label="Chart usage metric">
              <button type="button" aria-pressed={chartMetric === 'tokens'} onClick={() => setChartMetric('tokens')} className={`rounded-md px-3 py-1.5 text-sm ${chartMetric === 'tokens' ? 'bg-port-accent text-white' : 'text-port-text-muted'}`}>Tokens</button>
              <button type="button" aria-pressed={chartMetric === 'cost'} onClick={() => setChartMetric('cost')} className={`rounded-md px-3 py-1.5 text-sm ${chartMetric === 'cost' ? 'bg-port-accent text-white' : 'text-port-text-muted'}`}>API equivalent</button>
            </div>
            <div className="text-sm text-port-text-muted">{plotted.length} scored runs · {observations.length} total records</div>
          </div>
        </div>
        {plotted.length === 0 ? (
          <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed border-port-border px-4 text-center text-sm text-port-text-muted">
            {chartMetric === 'tokens'
              ? 'No PortOS benchmark runs yet. Choose a model and run the five-task suite to create the first point.'
              : 'No scored runs have a known API-equivalent token rate yet. Switch to Tokens to compare all providers, including local models.'}
          </div>
        ) : (
          <div className="h-[420px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 12, right: 20, bottom: 20, left: 6 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--port-border)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={chartMetric === 'tokens' ? 'Tokens per run' : 'API equivalent per 1,000 runs'}
                  tickFormatter={value => chartMetric === 'tokens' ? formatCount(value) : formatUsd(value)}
                  label={{ value: chartMetric === 'tokens' ? 'Tokens per five-task run' : 'Estimated API equivalent per 1,000 runs', position: 'insideBottom', offset: -8 }}
                />
                <YAxis type="number" dataKey="y" name="Score" domain={[0, 100]} tickFormatter={value => `${value}%`} label={{ value: 'Correct answers', angle: -90, position: 'insideLeft' }} />
                <Tooltip content={<BenchmarkTooltip />} />
                {grouped.map(group => <Scatter key={group.name} name={group.name} data={group.rows} fill={group.color} />)}
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-port-border bg-port-card p-4 md:p-5">
        <h2 className="mb-3 text-lg font-semibold">PortOS run history</h2>
        {observations.length === 0 ? (
          <p className="text-sm text-port-text-muted">Completed and partial PortOS benchmark runs will appear here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-port-border text-xs uppercase text-port-text-muted">
                <tr><th className="py-2 pr-3">Run date</th><th className="py-2 pr-3">Provider / model</th><th className="py-2 pr-3">Effort</th><th className="py-2 pr-3">Score</th><th className="py-2 pr-3">Tokens</th><th className="py-2 pr-3">API equivalent / 1,000 runs</th></tr>
              </thead>
              <tbody>
                {observations.map(row => (
                  <tr key={row.id} className="border-b border-port-border/60 last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap">{sourceDate(row).slice(0, 10) || '—'}</td>
                    <td className="py-2 pr-3"><span className="font-medium">{row.model}</span><span className="block text-xs text-port-text-muted">{row.provider}</span></td>
                    <td className="py-2 pr-3">{row.effort}</td>
                    <td className="py-2 pr-3">{row.quality ? `${formatCount(row.quality.value)}%` : `Incomplete (${row.completedTasks || 0}/${row.totalTasks || 5})`}</td>
                    <td className="py-2 pr-3">{row.tokensPerRun ? <>{formatCount(row.tokensPerRun.value)} <span className="text-xs text-port-text-muted">{row.tokenBasis}</span></> : '—'}</td>
                    <td className="py-2 pr-3">{row.apiEquivalentCost ? `~${formatUsd(row.apiEquivalentCost.value * 1000)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-port-text-muted">
          {BENCHMARK_NAME} checks short arithmetic, formatting, logic and code reading with deterministic answer matching. It is a small PortOS workload, not a claim to reproduce SWE-bench or another public leaderboard. Subscription allowance burn and free-tier quota remain unknown.
        </p>
      </section>
    </div>
  );
}
