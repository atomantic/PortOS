import { useCallback, useEffect, useMemo, useState } from 'react';
import { CartesianGrid, LabelList, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { getModelComparison } from '../../services/apiModelComparison';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage';
import { formatCount, formatUsd, formatPercent } from '../../utils/formatters';
import ComparisonResearch from './ComparisonResearch';
import ComparisonValueGuide from './ComparisonValueGuide';

const STORAGE = 'portos-composite-comparison-v1';
const COLORS = ['#2563eb', '#f97316', '#16a34a', '#9333ea', '#0891b2', '#db2777', '#ca8a04', '#dc2626'];
const PROVIDER_COLORS = {
  openai: '#10a37f',
  anthropic: '#d97706',
  google: '#2563eb',
  meta: '#0891b2',
  deepseek: '#4f46e5',
  mistral: '#ea580c',
  xai: '#9333ea',
  spacexai: '#9333ea',
  alibaba: '#7c3aed',
  qwen: '#7c3aed',
  amazon: '#d97706',
  microsoft: '#0284c7',
  nvidia: '#16a34a',
};

function getProviderColor(providerId, providerName, index = 0) {
  const idKey = String(providerId || '').toLowerCase();
  const nameKey = String(providerName || '').toLowerCase();
  for (const [key, color] of Object.entries(PROVIDER_COLORS)) {
    if (idKey.includes(key) || nameKey.includes(key)) return color;
  }
  return COLORS[index % COLORS.length];
}

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'unspecified', 'reasoning'];
const PRICES = [
  ['costPerTask', 'Cost per benchmark task (recommended)', 'USD / Intelligence Index task'],
  ['blendedPerMillion', 'Blended token price (3:1 input/output)', 'USD / 1M total tokens'],
  ['inputPerMillion', 'Input token price', 'USD / 1M input tokens'],
  ['outputPerMillion', 'Output token price', 'USD / 1M output tokens'],
];
const buttonClass = 'rounded-lg border border-port-border px-3 py-2 text-xs disabled:opacity-50';
const valueText = (metric, money = false) => metric ? `${metric.estimated ? '≈ ' : ''}${money ? formatUsd(metric.value, { maximumFractionDigits: 4 }) : formatCount(metric.value, { maximumFractionDigits: 1 })}` : 'Needs research';

function MetricEvidence({ metric }) {
  if (!metric) return <span>Needs research</span>;
  return <details><summary className="cursor-pointer">{metric.estimated ? 'Estimated' : 'Sourced'} · {formatCount(metric.sources.length)} references</summary>
    <p className="my-2 max-w-xl whitespace-normal text-port-text-muted">{metric.method}</p>
    <ul className="space-y-1">{metric.sources.map(source => <li key={source.url + source.retrievedAt}><a className="text-port-accent underline break-all" href={source.url} target="_blank" rel="noreferrer">{new URL(source.url).hostname}</a> · {source.retrievedAt.slice(0, 10)}<p className="max-w-xl whitespace-normal text-port-text-muted">{source.methodology}</p></li>)}</ul>
  </details>;
}

function ComparisonTooltip({ active, payload, priceId }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return <div className="max-w-xs rounded-lg border border-port-border bg-port-card p-3 text-sm shadow-lg">
    <strong>{row.model} ({row.effort})</strong><p>{row.provider}</p>{row.endpointModel !== row.model && <p className="text-xs break-all">{row.endpointModel}</p>}
    <p>{valueText(row.quality)} PortOS index</p><p>{valueText(row[priceId], true)}</p>
    <p className="mt-1 text-xs text-port-text-muted">{row.quality?.method}</p>
    <p className="mt-1 text-xs text-port-text-muted">{row[priceId]?.method}</p>
  </div>;
}

function GenerationDelta({ rows, priceId }) {
  const models = [...new Set(rows.map(row => row.model))].sort();
  if (models.length !== 2) return null;
  const efforts = [...new Set(rows.map(row => row.effort))].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const metricFor = (model, effort, field) => {
    const metrics = rows.filter(row => row.model === model && row.effort === effort).map(row => row[field]).filter(Boolean);
    return metrics.length && new Set(metrics.map(metric => metric.value)).size === 1 ? metrics[0] : null;
  };
  return <section className="rounded-xl border border-port-border bg-port-card p-4" aria-label="Pair comparison">
    <h2 className="font-semibold break-words">{models[1]} compared with {models[0]}</h2>
    <p className="text-xs text-port-text-muted">Matched effort levels. Differences with estimates carry ≈. Multiple provider prices require a narrower provider selection.</p>
    <div className="overflow-x-auto"><table className="mt-2 w-full text-left text-sm"><thead><tr><th className="p-2">Effort</th><th className="p-2">Intelligence change</th><th className="p-2">Cost change</th></tr></thead><tbody>{efforts.map(effort => {
      const before = metricFor(models[0], effort, 'quality'), after = metricFor(models[1], effort, 'quality');
      const oldCost = metricFor(models[0], effort, priceId), newCost = metricFor(models[1], effort, priceId);
      const delta = before && after ? after.value - before.value : null;
      const costChange = oldCost && newCost && oldCost.value > 0 ? (newCost.value - oldCost.value) / oldCost.value * 100 : null;
      return <tr key={effort} className="border-t border-port-border"><td className="p-2">{effort}</td><td className="p-2">{delta === null ? 'Not comparable' : `${before.estimated || after.estimated ? '≈ ' : ''}${delta > 0 ? '+' : ''}${formatCount(delta, { maximumFractionDigits: 2 })} points`}</td><td className="p-2">{costChange === null ? 'Not comparable' : `${oldCost.estimated || newCost.estimated ? '≈ ' : ''}${costChange > 0 ? '+' : ''}${formatPercent(costChange, { decimals: 1 })}`}</td></tr>;
    })}</tbody></table></div>
  </section>;
}

export default function ModelComparison() {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(() => {
    const saved = safeReadJsonStorage(STORAGE, {});
    return {
      models: Array.isArray(saved?.models) ? saved.models : null,
      efforts: Array.isArray(saved?.efforts) ? saved.efforts : null,
      provider: typeof saved?.provider === 'string' ? saved.provider : '',
      // Upgrade the old token-rate default once, retaining model/effort filters.
      axisVersion: 2,
      priceId: saved?.axisVersion !== 2 && saved?.priceId === 'blendedPerMillion'
        ? 'costPerTask'
        : PRICES.some(([id]) => id === saved?.priceId) ? saved.priceId : 'costPerTask',
      height: [420, 600, 720].includes(saved?.height) ? saved.height : 600,
      log: saved?.log === true,
    };
  });
  const [query, setQuery] = useState('');
  const [zoom, setZoom] = useState(true);
  const [researchOpen, setResearchOpen] = useState(false);
  const [showEstimates, setShowEstimates] = useState(true);
  const [evidenceLimit, setEvidenceLimit] = useState(100);
  const update = patch => setSettings(previous => ({ ...previous, ...patch }));
  useEffect(() => { safeWriteJsonStorage(STORAGE, settings); }, [settings]);
  useEffect(() => {
    let active = true;
    getModelComparison({ silent: true }).then(data => { if (active) setCatalog(data); })
      .catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const reload = useCallback(() => {
    setLoading(true); setError('');
    getModelComparison({ silent: true }).then(setCatalog).catch(err => setError(err.message)).finally(() => setLoading(false));
  }, []);
  const rows = useMemo(() => (catalog?.composite?.rows || []).map(row => {
    const result = { ...row, endpointModel: row.model, model: row.comparisonModel || row.model };
    for (const field of ['quality', 'inputPerMillion', 'outputPerMillion', 'blendedPerMillion', 'costPerTask']) {
      const metric = row[field];
      if (metric) result[field] = { ...metric, sources: metric.sources || (metric.sourceIds || []).map(id => catalog.composite.sources[id]).filter(Boolean) };
    }
    return result;
  }), [catalog]);
  const providers = [...new Map(rows.map(row => [row.providerId, row.provider])).entries()];
  const providerColorMap = useMemo(() => {
    const map = new Map();
    providers.forEach(([id, name], index) => {
      map.set(id, getProviderColor(id, name, index));
    });
    return map;
  }, [providers]);
  const modelProvider = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      if (row.model && !map.has(row.model)) {
        map.set(row.model, { providerId: row.providerId, provider: row.provider });
      }
    }
    return map;
  }, [rows]);
  const scoped = rows.filter(row => !settings.provider || row.providerId === settings.provider);
  const models = [...new Set(scoped.map(row => row.model))].sort();
  const matches = models.filter(model => !query || query.toLowerCase().split(',').some(term => model.toLowerCase().includes(term.trim())));
  const efforts = [...new Set(scoped.map(row => row.effort))].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
  const selected = scoped.filter(row => (settings.models === null || settings.models.includes(row.model)) && (settings.efforts === null || settings.efforts.includes(row.effort)));
  const price = PRICES.find(([id]) => id === settings.priceId) || PRICES[0];
  const plotCandidates = selected.filter(row => row.quality && row[price[0]] && (showEstimates || (!row.quality.estimated && !row[price[0]].estimated)) && (!settings.log || row[price[0]].value > 0))
    .map(row => ({ ...row, x: row[price[0]].value, y: row.quality.value, label: `${row.model} (${row.effort})${row.quality.estimated || row[price[0]].estimated ? ' ≈' : ''}` }));
  const plotted = [...plotCandidates.reduce((unique, row) => {
    const key = `${row.model}:${row.effort}:${row.x}:${row.y}:${row.quality.estimated}:${row[price[0]].estimated}`;
    const prior = unique.get(key);
    if (prior) {
      if (!prior.providers.includes(row.provider)) prior.providers.push(row.provider);
      prior.provider = prior.providers.join(', ');
    } else unique.set(key, { ...row, providers: [row.provider] });
    return unique;
  }, new Map()).values()];
  const excludedCount = selected.length - plotCandidates.length;
  const groups = useMemo(() => {
    const result = new Map();
    for (const row of plotted) {
      if (!result.has(row.modelKey)) result.set(row.modelKey, []);
      result.get(row.modelKey).push(row);
    }
    return [...result].map(([key, points]) => ({ key, points: points.sort((a, b) => EFFORTS.indexOf(a.effort) - EFFORTS.indexOf(b.effort)) }));
  }, [plotted]);
  const toggle = (key, value, all) => update({ [key]: (settings[key] ?? all).includes(value) ? (settings[key] ?? all).filter(item => item !== value) : [...(settings[key] ?? all), value] });
  const researchCount = rows.filter(row => row.needsResearch).length;

  return <div className="@container mx-auto w-full min-w-0 space-y-4 p-3 md:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">Cost vs. intelligence</h1><p className="text-sm text-port-text-muted">Compare generations, peers and reasoning efforts across your selectable models.</p></div>
      <div className="flex flex-wrap gap-2"><button className={buttonClass} onClick={reload} disabled={loading}>{loading ? 'Loading…' : 'Reload data'}</button><button className={buttonClass} aria-expanded={researchOpen} onClick={() => setResearchOpen(value => !value)}>Research gaps ({formatCount(researchCount)})</button></div>
    </div>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {researchOpen && <ComparisonResearch />}
    <section className="min-w-0 rounded-xl border border-port-border bg-port-card p-4 space-y-3" aria-label="Comparison controls">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0"><label htmlFor="comparison-price" className="block text-xs mb-1">Cost axis</label><select className="max-w-full rounded-lg border border-port-border bg-port-bg p-2 text-sm" id="comparison-price" value={price[0]} onChange={event => update({ priceId: event.target.value })}>{PRICES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
        <div className="min-w-0"><label htmlFor="comparison-provider" className="block text-xs mb-1">Provider filter</label><select className="max-w-full rounded-lg border border-port-border bg-port-bg p-2 text-sm" id="comparison-provider" value={settings.provider} onChange={event => update({ provider: event.target.value })}><option value="">All providers</option>{providers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showEstimates} onChange={event => setShowEstimates(event.target.checked)} />Include estimates</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.log} onChange={event => update({ log: event.target.checked })} />Log cost scale</label>
      </div>
      <div className="flex flex-wrap items-center gap-2" aria-label="Effort toggles"><span className="text-sm">Effort</span><button className={buttonClass} onClick={() => update({ efforts: null })}>All efforts</button>{efforts.map(effort => <button key={effort} className={buttonClass} aria-pressed={settings.efforts === null || settings.efforts.includes(effort)} onClick={() => toggle('efforts', effort, efforts)}>{settings.efforts === null || settings.efforts.includes(effort) ? '✓ ' : ''}{effort}</button>)}</div>
      <div className="flex flex-wrap items-center gap-2"><label htmlFor="comparison-search" className="sr-only">Filter models</label><input id="comparison-search" className="min-w-0 w-72 max-w-full rounded-lg border border-port-border bg-port-bg p-2 text-sm" placeholder="Find models, e.g. luna or comma-separated names" value={query} onChange={event => setQuery(event.target.value)} /><button className={buttonClass} onClick={() => update({ models: matches })}>Compare matching</button><button className={buttonClass} onClick={() => update({ models: null })}>All models</button><button className={buttonClass} onClick={() => update({ models: [] })}>Clear models</button></div>
      <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto" aria-label="Model toggles">{matches.map(model => {
        const info = modelProvider.get(model);
        const color = info ? (providerColorMap.get(info.providerId) || getProviderColor(info.providerId, info.provider, 0)) : COLORS[models.indexOf(model) % COLORS.length];
        const isSelected = settings.models === null || settings.models.includes(model);
        return <button key={model} className={`${buttonClass} max-w-full break-all text-left inline-flex items-center gap-1.5`} aria-pressed={isSelected} onClick={() => toggle('models', model, models)}><span className="inline-block h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: color }} /><span>{isSelected ? '✓ ' : ''}{model}</span></button>;
      })}</div>
      <p className="text-xs text-port-text-muted">{formatCount(plotted.length)} plotted / {formatCount(selected.length)} selected configurations · {formatCount(excludedCount)} missing this metric or excluded · {formatCount(plotCandidates.length - plotted.length)} identical provider points combined. ≈ identifies estimates. Zero prices remain visible on the linear scale.</p>
    </section>
    <section className="min-w-0 rounded-xl border border-port-border bg-port-card p-3" aria-label="Cost versus intelligence chart">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">PortOS intelligence index vs. {price[1].toLowerCase()}</h2><div className="flex flex-wrap gap-2"><button className={buttonClass} aria-pressed={zoom} onClick={() => setZoom(value => !value)}>{zoom ? 'Reset axes' : 'Fit visible'}</button>{[420, 600, 720].map(height => <button key={height} className={buttonClass} aria-pressed={settings.height === height} onClick={() => update({ height })}>{height}px</button>)}</div></div>
      {plotted.length ? <div style={{ height: settings.height }} className="w-full min-w-0" role="img" aria-label="PortOS intelligence versus cost; lower cost and higher intelligence are preferred">
        <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 35, right: 30, bottom: 35, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--port-border))" />
          <XAxis tick={{ fill: 'rgb(var(--port-text-muted))' }} type="number" dataKey="x" scale={settings.log ? 'log' : 'auto'} domain={settings.log || zoom ? ['dataMin', 'dataMax'] : [0, 'auto']} tickFormatter={value => formatUsd(value, { maximumFractionDigits: 4 })} label={{ value: price[2], fill: 'rgb(var(--port-text-muted))', position: 'insideBottom', offset: -20 }} />
          <YAxis tick={{ fill: 'rgb(var(--port-text-muted))' }} type="number" dataKey="y" domain={zoom ? [dataMin => Number.isFinite(dataMin) ? Math.max(0, Math.floor(dataMin - 2)) : 0, dataMax => Number.isFinite(dataMax) ? Math.ceil(dataMax + 2) : 'auto'] : [0, 'auto']} tickFormatter={value => formatCount(value, { maximumFractionDigits: 1 })} label={{ value: 'PortOS intelligence index', fill: 'rgb(var(--port-text-muted))', angle: -90, position: 'insideLeft' }} />
          <Tooltip content={<ComparisonTooltip priceId={price[0]} />} />
          {groups.map(({ key, points }) => {
            const firstPoint = points[0];
            const providerId = firstPoint?.providerId;
            const color = providerColorMap.get(providerId) || getProviderColor(providerId, firstPoint?.provider, models.indexOf(firstPoint?.model));
            return <Scatter isAnimationActive={false} key={key} name={key} data={points} fill={color} line={points.length > 1 ? { strokeDasharray: '4 4', strokeWidth: 2 } : false}>{plotted.length <= 30 && <LabelList className="hidden @xl:block" dataKey="label" position="top" fontSize={11} fill="rgb(var(--port-text))" />}</Scatter>;
          })}
        </ScatterChart></ResponsiveContainer>
      </div> : <p className="p-10 text-center text-sm text-port-text-muted">{loading ? 'Loading comparison…' : 'No points match these choices. Select models and efforts, change the cost axis, or research missing evidence.'}</p>}
      <div className="flex flex-wrap gap-3 text-xs" aria-label="Chart legend">{[...new Set(plotted.map(row => row.model))].map(model => {
        const info = modelProvider.get(model);
        const color = info ? (providerColorMap.get(info.providerId) || getProviderColor(info.providerId, info.provider, 0)) : COLORS[0];
        return <span key={model} className="break-all inline-flex items-center gap-1" style={{ color }}>● {model}</span>;
      })}</div>
      <p className="mt-3 text-xs text-port-text-muted">{price[0] === 'costPerTask'
        ? 'Task cost includes the token usage of each model and effort on the same benchmark. It is an API reference cost, not a quote for your workload or subscription. Missing task costs stay unplotted until researched; token rates are never substituted.'
        : 'Token price is the rate per token, not cost per task. Higher effort can use more reasoning tokens at the same rate, so vertical effort curves do not mean equal task cost. Choose Cost per benchmark task to compare reasoning expense.'}</p>
    </section>
    <ComparisonValueGuide rows={selected} />
    <GenerationDelta rows={selected} priceId={price[0]} />
    <details className="rounded-xl border border-port-border bg-port-card p-4"><summary className="cursor-pointer font-medium">Methodology and confidence</summary><p className="mt-2 text-sm text-port-text-muted">PortOS index v1 uses {catalog?.composite?.anchor || 'the versioned reference index'} as its stable scale. Exact results take priority. Other evaluations are calibrated using at least three shared model/effort configurations, then combined by their median. Uncalibrated benchmark scores are never mixed directly. Missing effort levels use interpolation or a low-confidence nearest-effort estimate for the same model. Unknown members of a recognized family receive a low-confidence median family baseline with source range. No improvement is assumed for a new generation without evidence. Each estimate retains its method and source dates below; missing models stay in the coverage list for research.</p></details>
    <details className="rounded-xl border border-port-border bg-port-card p-4"><summary className="cursor-pointer font-medium">Selected configurations and evidence ({formatCount(selected.length)})</summary><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm"><thead><tr><th className="p-2">Model / provider</th><th className="p-2">Effort</th><th className="p-2">Intelligence</th><th className="p-2">Cost</th><th className="p-2">Performance evidence</th><th className="p-2">Cost evidence</th></tr></thead><tbody>{selected.slice(0, evidenceLimit).map(row => <tr key={row.id} className="border-t border-port-border"><td className="p-2">{row.model}<span className="block text-xs text-port-text-muted">{row.provider}{row.endpointModel !== row.model ? ` · ${row.endpointModel}` : ''}</span></td><td className="p-2">{row.effort}</td><td className="p-2">{valueText(row.quality)}</td><td className="p-2">{valueText(row[price[0]], true)}</td><td className="p-2">{row.incomparableReason ? <p className="max-w-sm whitespace-normal">{row.incomparableReason}</p> : <MetricEvidence metric={row.quality} />}</td><td className="p-2"><MetricEvidence metric={row[price[0]]} /></td></tr>)}</tbody></table></div>{selected.length > evidenceLimit && <button className={buttonClass} onClick={() => setEvidenceLimit(value => value + 100)}>Show 100 more configurations</button>}</details>
  </div>;
}
