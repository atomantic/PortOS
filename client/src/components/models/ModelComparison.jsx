import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowUpRight, ChartScatter, Check, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { CartesianGrid, LabelList, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { getModelComparison, importModelComparison, discoverComparisonModels } from '../../services/apiModelComparison';
import ComparisonResearch from './ComparisonResearch';

const COLORS = ['#60a5fa', '#fb923c', '#4ade80', '#f87171', '#c084fc', '#22d3ee'];
const METRICS = ['quality', 'costPerTask', 'inputPerMillion', 'outputPerMillion', 'reasoningPerMillion', 'responseSeconds', 'tokensPerSecond', 'quota'];
const STALE_MS = 30 * 86400000;

export default function ModelComparison() {
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const [scenario, setScenario] = useState({ input: 10000, output: 500, reasoning: 0, tasks: 100 });
  const load = useCallback(() => getModelComparison({ silent: true }), []);
  useEffect(() => {
    let active = true;
    load().then(data => { if (active) setCatalog(data); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [load]);
  const changeParam = (key, value) => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (value) next.set(key, value); else next.delete(key);
    return next;
  }, { replace: true });
  const toggle = (key, value) => setParams(previous => {
    const next = new URLSearchParams(previous);
    const values = new Set(next.getAll(key));
    if (values.has(value)) values.delete(value); else values.add(value);
    next.delete(key);
    for (const item of values) next.append(key, item);
    return next;
  }, { replace: true });
  const refreshView = () => {
    setBusy(true); setError('');
    load().then(setCatalog).catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  const discover = providerId => {
    setBusy(true); setError('');
    discoverComparisonModels(providerId, { silent: true }).then(result => {
      setCatalog(previous => ({ ...previous, inventory: previous.inventory.map(provider => provider.id === providerId ? { ...provider, models: result.models } : provider) }));
    }).catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  const importFile = event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 1000000) { setError('Catalog file must be smaller than 1 MB.'); return; }
    setBusy(true); setError('');
    file.text().then(JSON.parse).then(data => importModelComparison(data, { silent: true }))
      .then(data => setCatalog(previous => ({ ...previous, ...data })))
      .catch(err => setError(err.message)).finally(() => setBusy(false));
  };
  if (!catalog) return <div role={error ? 'alert' : 'status'}>{error || 'Loading comparison data…'}{error && <button onClick={refreshView} disabled={busy}>Retry</button>}</div>;
  const benchmarks = [...new Set(catalog.observations.map(row => row.benchmark))].sort();
  const benchmark = benchmarks.includes(params.get('benchmark')) ? params.get('benchmark') : benchmarks.at(-1);
  const providers = [...new Set(catalog.observations.map(row => row.provider))].sort();
  const models = [...new Set(catalog.observations.map(row => row.model))].sort();
  const efforts = [...new Set(catalog.observations.map(row => row.effort))].sort();
  const mode = params.get('cost') === 'scenario' ? 'scenario' : 'benchmark';
  const visible = catalog.observations.filter(row => row.benchmark === benchmark &&
    !params.getAll('hideProvider').includes(row.provider) && !params.getAll('hideModel').includes(row.model) &&
    !params.getAll('hideEffort').includes(row.effort));
  const rows = visible.map(row => {
    const cost = mode === 'benchmark' ? row.costPerTask?.value : row.billing === 'api' &&
      (scenario.input === 0 || row.inputPerMillion) && (scenario.output === 0 || row.outputPerMillion) &&
      (scenario.reasoning === 0 || row.reasoningPerMillion)
      ? (scenario.input * (row.inputPerMillion?.value || 0) + scenario.output * (row.outputPerMillion?.value || 0) +
        scenario.reasoning * (row.reasoningPerMillion?.value || 0)) / 1000000 : null;
    return { ...row, x: cost, y: row.quality?.value, label: `${row.model} (${row.effort})${row.responseSeconds ? ` · ${row.responseSeconds.value}s` : ''}` };
  });
  const plotted = rows.filter(row => Number.isFinite(row.x) && Number.isFinite(row.y));
  return <div className="space-y-5 min-w-0">
    <div className="flex flex-wrap justify-between gap-4 items-start">
      <div className="max-w-2xl"><div className="flex items-center gap-2 text-xs font-medium tracking-widest uppercase text-port-accent-text mb-2"><ChartScatter size={15} aria-hidden="true" /> Model comparison</div><h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">Model intelligence, cost & effort</h2>
        <p className="text-sm text-port-text-muted mt-2 leading-relaxed">Published evidence, with source dates and exact configurations. Missing data stays unknown.</p></div>
      <div className="flex flex-wrap gap-2"><button className="inline-flex items-center gap-2 px-3 py-2.5 text-sm bg-port-card border border-port-border rounded-xl hover:border-port-accent transition-colors" onClick={() => changeParam('research', params.get('research') === '1' ? '' : '1')} aria-expanded={params.get('research') === '1'}><SlidersHorizontal size={15} aria-hidden="true" />Research & schedule</button>
      <button className="inline-flex items-center gap-2 px-3 py-2.5 text-sm bg-port-card border border-port-border rounded-xl hover:border-port-accent disabled:opacity-50 transition-colors" disabled={busy} onClick={refreshView}><RefreshCw size={15} aria-hidden="true" className={busy ? 'animate-spin' : ''} />Reload data</button></div>
    </div>
    {params.get('research') === '1' && <ComparisonResearch />}
    {error && <p role="alert" className="text-port-error">{error}</p>}
    <div className="flex flex-wrap gap-4 items-end bg-port-card border border-port-border rounded-2xl p-4">
      <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-benchmark">Benchmark<br /><select id="comparison-benchmark" className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2" value={benchmark} onChange={e => changeParam('benchmark', e.target.value)}>{benchmarks.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="min-w-0 max-w-full text-xs font-medium text-port-text-muted space-y-2" htmlFor="comparison-cost">Cost basis<br /><select id="comparison-cost" className="bg-port-bg text-port-text border border-port-border rounded-lg p-2.5 text-sm max-w-full mt-2" value={mode} onChange={e => changeParam('cost', e.target.value)}><option value="benchmark">Published benchmark cost / task</option><option value="scenario">My token workload estimate</option></select></label>
      <label className="flex items-center gap-2 self-end py-2.5 text-sm text-port-text-muted" htmlFor="comparison-labels"><input id="comparison-labels" type="checkbox" className="accent-port-accent size-4 shrink-0" checked={params.get('labels') === '1'} onChange={e => changeParam('labels', e.target.checked ? '1' : '')} />Point labels</label>
    </div>
    {mode === 'scenario' && <div className="bg-port-card border border-port-border p-4 rounded-2xl space-y-3">
      <div className="flex flex-wrap gap-3">{[['input', 'Uncached input tokens'], ['output', 'Answer tokens'], ['reasoning', 'Reasoning tokens'], ['tasks', 'Number of tasks']].map(([key, label]) => <label key={key} htmlFor={`comparison-${key}`}>{label}<br /><input id={`comparison-${key}`} type="number" min="0" max="1000000000" className="w-36 bg-port-bg border border-port-border p-2 rounded" value={scenario[key]} onChange={e => setScenario(previous => ({ ...previous, [key]: Math.max(0, Math.min(1e9, Number(e.target.value) || 0)) }))} /></label>)}</div>
      <p className="text-sm text-port-text-muted">Estimate uses the entered tokens and published rates. Quality remains the published benchmark score; it does not predict quality at this token budget. Include reasoning tokens when applicable. Cache, batch, context-tier discounts and taxes are excluded.</p>
    </div>}
    <div className="bg-port-card border border-port-border rounded-2xl overflow-hidden">
      <div className="px-4 sm:px-6 pt-5 pb-4 border-b border-port-border">
        <div className="flex flex-wrap justify-between items-start gap-3 mb-3">
          <div><h3 className="font-semibold text-lg tracking-tight">Quality vs. cost</h3><p className="text-xs text-port-text-muted mt-1">{benchmark}</p></div>
          <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full bg-port-bg border border-port-border px-3 py-1.5 text-xs text-port-text-muted"><ArrowUpRight size={14} aria-hidden="true" className="-rotate-90" />Prefer higher scores, lower cost</span>
        </div>
      <p className="text-xs text-port-text-muted mb-3" aria-live="polite">{plotted.length} plotted · {rows.length - plotted.length} missing quality or cost</p>
      <div className="flex flex-wrap gap-2" aria-label="Toggle chart models">{models.map((model, index) => {
        const selected = !params.getAll('hideModel').includes(model);
        return <button key={model} type="button" aria-pressed={selected} aria-label={`Toggle ${model}`} onClick={() => toggle('hideModel', model)}
          className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-colors hover:border-port-accent ${selected ? 'bg-port-bg border-port-border text-port-text' : 'border-transparent text-port-text-muted opacity-60'}`}>
          <span className="size-3 rounded-full flex items-center justify-center" style={{ backgroundColor: selected ? COLORS[index % COLORS.length] : 'transparent', border: `1px solid ${COLORS[index % COLORS.length]}` }}>{selected && <Check size={10} color="#111827" aria-hidden="true" />}</span>{model}
        </button>;
      })}</div>
      </div>
      {plotted.length ? <div className="h-[360px] sm:h-[460px] px-1 sm:px-4 pt-4" role="img" aria-label={`Quality versus ${mode === 'benchmark' ? 'benchmark' : 'estimated'} cost per task. Exact values and source links are in the table below.`}>
        <ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 32, right: 24, bottom: 32, left: 0 }}>
          <CartesianGrid strokeDasharray="3 5" stroke="rgb(var(--port-border))" vertical={false} />
          <XAxis tick={{ fill: 'rgb(var(--port-text-muted))', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'rgb(var(--port-border))' }} type="number" dataKey="x" name="USD / task" domain={[0, 'auto']} tickFormatter={value => `$${value}`} label={{ value: 'USD / task (linear)', position: 'bottom', fill: 'rgb(var(--port-text-muted))', fontSize: 12 }} />
          <YAxis tick={{ fill: 'rgb(var(--port-text-muted))', fontSize: 11 }} tickLine={false} axisLine={{ stroke: 'rgb(var(--port-border))' }} type="number" dataKey="y" name="Benchmark score" domain={['auto', 'auto']} width={55} label={{ value: 'Quality', angle: -90, position: 'insideLeft', fill: 'rgb(var(--port-text-muted))', fontSize: 12 }} />
          <Tooltip cursor={{ strokeDasharray: '4 4', stroke: 'rgb(var(--port-text-muted))' }} content={({ active, payload }) => active && payload?.[0] ? <div className="bg-port-bg border border-port-border rounded-xl shadow-xl p-4 text-sm max-w-64 break-words"><p className="font-semibold mb-2">{payload[0].payload.label}</p><p className="text-port-text-muted">{payload[0].payload.provider} · ${payload[0].payload.x.toFixed(4)} / task</p><p className="mt-1 font-medium">Score: {payload[0].payload.y}</p></div> : null} />
          {models.map((model, index) => <Scatter key={model} name={model} isAnimationActive={false} data={plotted.filter(row => row.model === model)} fill={COLORS[index % COLORS.length]} stroke="rgb(var(--port-card))" strokeWidth={2} shape={({ cx, cy, fill }) => <g><circle cx={cx} cy={cy} r={10} fill={fill} fillOpacity={0.14} stroke="none" /><circle cx={cx} cy={cy} r={5} fill={fill} stroke="rgb(var(--port-card))" strokeWidth={1.5} /></g>}>{params.get('labels') === '1' && plotted.length <= 12 && <LabelList className="hidden md:block" dataKey="label" position="top" fill="currentColor" fontSize={10} />}</Scatter>)}
        </ScatterChart></ResponsiveContainer>
      </div> : <p className="py-12 text-center text-port-text-muted">No comparable points for these filters. Adjust filters or refresh the research catalog.</p>}
      <p className="text-xs leading-relaxed text-port-text-muted border-t border-port-border px-4 sm:px-6 py-4">Response-time labels are measured source workloads, independent of the intelligence evaluation. API dollars cannot be converted into subscription quota. Local hardware costs are not assumed to be zero.</p>
    </div>
    <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm"><summary className="cursor-pointer font-medium">Show or hide providers, models & effort</summary>
      <div className="grid md:grid-cols-3 gap-4 mt-3">{[['Providers', 'hideProvider', providers], ['Models', 'hideModel', models], ['Effort', 'hideEffort', efforts]].map(([title, key, values]) => <fieldset key={key} className="max-h-48 overflow-auto space-y-1"><legend className="font-semibold">{title}</legend>{values.map(value => <label htmlFor={`${key}-${encodeURIComponent(value)}`} key={value} className="flex items-center gap-2 py-1"><input id={`${key}-${encodeURIComponent(value)}`} type="checkbox" className="accent-port-accent size-4 shrink-0" checked={!params.getAll(key).includes(value)} onChange={() => toggle(key, value)} />{value}</label>)}</fieldset>)}</div>
    </details>
    <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm"><summary className="cursor-pointer font-semibold">Evidence & sources ({rows.length} configurations)</summary><div className="overflow-x-auto"><table className="w-full text-sm text-left"><caption className="text-left font-semibold py-2">Evidence and estimates</caption><thead className="text-xs text-port-text-muted bg-port-bg"><tr>{['Provider / model / effort', 'Quality', 'USD / task', 'Scenario total', 'Response / speed', 'Quota', 'Sources & freshness'].map(label => <th className="p-3" key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} className="border-t border-port-border align-top hover:bg-port-bg/50">
        <td className="p-3"><strong>{row.provider} · {row.model} ({row.effort})</strong><p>{row.billing} · {row.configuration}</p><p className="text-port-text-muted">{row.notes}</p></td>
        <td className="p-3">{row.y ?? 'Unknown'}</td><td className="p-3">{Number.isFinite(row.x) ? `$${row.x.toFixed(4)}` : 'Unknown'}</td>
        <td className="p-3">{mode === 'scenario' && Number.isFinite(row.x) ? `$${(row.x * scenario.tasks).toFixed(2)}` : '—'}</td>
        <td className="p-3">{row.responseSeconds ? `${row.responseSeconds.value}s E2E` : 'E2E unknown'}<br />{row.tokensPerSecond ? `${row.tokensPerSecond.value} tok/s` : 'Speed unknown'}</td>
        <td className="p-3">{row.quota ? `${row.quota.unitsPerTask} ${row.quota.unit}/task${mode === 'scenario' ? ` · ${row.quota.unitsPerTask * scenario.tasks} total` : ''}` : 'Unknown'}</td>
        <td className="p-2 min-w-56">{METRICS.filter(key => row[key]).map(key => <p key={key} className="mb-2"><a className="text-port-accent-text underline" href={row[key].source.url} target="_blank" rel="noreferrer">{key}</a> · {row[key].source.retrievedAt.slice(0, 10)}{Date.now() - Date.parse(row[key].source.retrievedAt) > STALE_MS && <strong> · Stale</strong>}<br /><span className="text-port-text-muted">{row[key].source.methodology}</span></p>)}</td>
      </tr>)}</tbody></table></div></details>
    <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm"><summary>Configured provider coverage ({catalog.inventory?.length || 0} providers)</summary>
      <p className="text-sm text-port-text-muted my-2">Model-name matches are references only, not measurements of this endpoint. Quantization, local hardware, harnesses and billing may differ. Refresh model lists in <Link className="text-port-accent-text underline" to="/models/harnesses">Harnesses</Link> or <Link className="text-port-accent-text underline" to="/models/llms/library">LLMs</Link>, then reload here.</p>
      {catalog.inventory?.map(provider => <div key={provider.id} className="my-3"><strong>{provider.name}</strong>{provider.canDiscover && <button className="ml-3 underline text-port-accent-text" disabled={busy} onClick={() => discover(provider.id)}>Discover current models</button>}<ul>{provider.models.map(({ model, efforts: supported }) => <li key={model}>{model} {supported.length ? `(${supported.join(', ')})` : ''} — {catalog.observations.some(row => row.model === model) ? 'Public model reference available; endpoint equivalence unverified' : 'Needs research'}</li>)}</ul></div>)}
    </details>
    <details className="bg-port-card border border-port-border rounded-xl p-4 text-sm"><summary>Import sourced observations</summary><p className="text-sm my-2">Import a version 1 catalog following docs/MODEL-COMPARISON.md. Valid observations merge by stable ID; missing or older metrics preserve existing evidence.</p><label htmlFor="comparison-import">Catalog JSON</label><input id="comparison-import" type="file" accept="application/json,.json" disabled={busy} onChange={importFile} className="block my-2" /></details>
    <p className="text-xs text-port-text-muted">Benchmark attribution: <a className="underline" href="https://artificialanalysis.ai/" target="_blank" rel="noreferrer">Artificial Analysis</a>. Source-specific methodologies appear above. Entries older than 30 days are marked stale.</p>
  </div>;
}
