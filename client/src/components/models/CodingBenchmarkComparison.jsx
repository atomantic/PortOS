import { useState } from 'react';
import { CartesianGrid, LabelList, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCount, formatDateNumeric, formatUsd } from '../../utils/formatters';
import { CODING_BENCHMARKS } from './codingBenchmarkData';

const ALL = '';
const selectClass = 'max-w-full rounded-lg border border-port-border bg-port-bg p-2 text-sm';
const panelClass = 'min-w-0 rounded-xl border border-port-border bg-port-card p-4';
const colors = ['#2563eb', '#f97316', '#16a34a', '#9333ea', '#0891b2', '#db2777', '#ca8a04', '#dc2626'];
const formatScore = (value, suite) => `${formatCount(value, { maximumFractionDigits: suite.scoreDecimals })}${suite.scoreSuffix}`;
const formatCost = value => formatUsd(value);
const pointName = row => `${row.model} · ${row.effort}`;

function BenchmarkSource({ suite }) {
  return <figcaption className="border-t border-port-border px-3 py-2 text-sm text-port-text-muted">
    Source: <a className="text-port-accent underline" href={suite.source} target="_blank" rel="noreferrer">{suite.name}</a>
    {' · Snapshot checked '}<time dateTime={suite.checkedOn}>{formatDateNumeric(suite.checkedOn)}</time>
  </figcaption>;
}

function BenchmarkChart({ rows, suite }) {
  const models = [...new Set(rows.map(row => row.model))];
  return <section className={panelClass} aria-label="Coding score versus cost chart">
    <h2 className="font-semibold">Coding score vs. benchmark task cost</h2>
    <figure className="mt-2 rounded-lg border border-port-border">
    {rows.length ? <div className="h-[380px] w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart title={`${suite.name} score vs. task cost`} desc="Higher scores and lower costs are better. Exact values and agent setups are in the table." margin={{ top: 24, right: 32, bottom: 28, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--port-border))" />
          <XAxis type="number" dataKey="usd" name="USD / task" scale="log" domain={[0.1, 100]} ticks={[0.1, 1, 10, 100]} tickFormatter={formatCost} tick={{ fill: 'rgb(var(--port-text-muted))' }} label={{ value: 'Average USD / task (log scale)', position: 'insideBottom', offset: -15, fill: 'rgb(var(--port-text-muted))' }} />
          <YAxis type="number" dataKey="score" name={suite.scoreLabel} domain={[0, 100]} tick={{ fill: 'rgb(var(--port-text-muted))' }} label={{ value: suite.scoreLabel, position: 'insideLeft', angle: -90, fill: 'rgb(var(--port-text-muted))' }} />
          <Tooltip content={<BenchmarkTooltip suite={suite} />} />
          {models.map((model, index) => <Scatter key={model} name={model} data={rows.filter(row => row.model === model)} fill={colors[index % colors.length]} isAnimationActive={false}>
            {rows.length <= 5 && <LabelList dataKey="effort" position="top" fill="rgb(var(--port-text))" fontSize={11} />}
          </Scatter>)}
        </ScatterChart>
      </ResponsiveContainer>
    </div> : <p className="py-8 text-center text-sm text-port-text-muted">No published results for this filter combination.</p>}
    <div className="flex flex-wrap gap-3 px-3 py-2 text-xs" aria-label="Coding benchmark chart legend">{models.map((model, index) => <span key={model} className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: colors[index % colors.length] }} />{model}
    </span>)}</div>
    <BenchmarkSource suite={suite} />
    </figure>
  </section>;
}

function BenchmarkTooltip({ active, payload, suite }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return <div className="max-w-xs rounded-lg border border-port-border bg-port-card p-3 text-sm shadow-lg">
    <strong>{pointName(row)}</strong>
    <p>{row.harness}{row.variant && ` · ${row.variant}`}</p>
    <p>{suite.scoreLabel}: {formatScore(row.score, suite)}</p>
    <p>{formatCost(row.usd)} / task</p>
  </div>;
}

function BenchmarkTable({ rows, suite }) {
  return <div className="overflow-x-auto">
    <table className="w-full min-w-[540px] text-left text-sm">
      <caption className="sr-only">{suite.name} benchmark results</caption>
      <thead><tr>
        <th scope="col" className="p-2">Model</th><th scope="col" className="p-2">Agent setup</th><th scope="col" className="p-2">Effort</th>
        <th scope="col" className="p-2">{suite.scoreLabel}</th><th scope="col" className="p-2">Average USD / task</th><th scope="col" className="p-2">Evidence</th>
      </tr></thead>
      <tbody>{[...rows].sort((a, b) => b.score - a.score || a.usd - b.usd).map(row => <tr key={row.id} className="border-t border-port-border">
        <th scope="row" className="p-2 font-medium">{row.model}</th>
        <td className="p-2">{row.harness}{row.variant && <span className="block text-xs text-port-text-muted">{row.variant}</span>}</td>
        <td className="p-2">{row.effort}</td>
        <td className="p-2 tabular-nums">{formatScore(row.score, suite)}</td>
        <td className="p-2 tabular-nums">{formatCost(row.usd)}</td>
        <td className="p-2"><a className="text-port-accent underline" href={row.source} target="_blank" rel="noreferrer" aria-label={`${suite.sourceName} result for ${pointName(row)}`}>{suite.sourceName}</a></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function BenchmarkFilter({ id, label, value, onChange, options, allLabel }) {
  return <div className="min-w-0">
    <label className="mb-1 block text-xs" htmlFor={id}>{label}</label>
    <select className={selectClass} id={id} value={value} onChange={event => onChange(event.target.value)}>
      {allLabel && <option value={ALL}>{allLabel}</option>}
      {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </div>;
}

const optionList = (rows, key) => [...new Set(rows.map(row => row[key]))].sort().map(value => [value, value]);

export default function CodingBenchmarkComparison() {
  const [suiteId, setSuiteId] = useState(CODING_BENCHMARKS[0].id);
  const [harness, setHarness] = useState(ALL);
  const [model, setModel] = useState(ALL);
  const [effort, setEffort] = useState(ALL);
  const suite = CODING_BENCHMARKS.find(item => item.id === suiteId) || CODING_BENCHMARKS[0];
  const rows = suite.rows.filter(row => (!harness || row.harness === harness) && (!model || row.model === model) && (!effort || row.effort === effort));
  const changeBenchmark = value => { setSuiteId(value); setHarness(ALL); setModel(ALL); setEffort(ALL); };

  return <div className="mx-auto w-full min-w-0 space-y-4 p-3 md:p-5">
    <header>
      <h1 className="text-xl font-semibold">Coding benchmark comparison</h1>
      <p className="text-sm text-port-text-muted">Compare published coding scores and average API costs on the same tasks. Benchmark suites are shown separately; costs are not subscription charges.</p>
    </header>
    <section className={`${panelClass} space-y-3`} aria-label="Coding benchmark filters">
      <div className="flex flex-wrap items-end gap-3">
        <BenchmarkFilter id="coding-benchmark" label="Benchmark" value={suiteId} onChange={changeBenchmark} options={CODING_BENCHMARKS.map(item => [item.id, item.name])} />
        <BenchmarkFilter id="coding-harness" label="Agent setup" value={harness} onChange={setHarness} options={optionList(suite.rows, 'harness')} allLabel="All agent setups" />
        <BenchmarkFilter id="coding-model" label="Model" value={model} onChange={setModel} options={optionList(suite.rows, 'model')} allLabel="All models" />
        <BenchmarkFilter id="coding-effort" label="Reasoning effort" value={effort} onChange={setEffort} options={optionList(suite.rows, 'effort')} allLabel="All efforts" />
      </div>
      <p className="text-sm text-port-text-muted">{suite.description}</p>
      <p className="text-xs text-port-text-muted">{formatCount(rows.length)} published results match these filters. This is a curated comparison, not the full leaderboard. Missing efforts are not estimated.</p>
    </section>
    <BenchmarkChart rows={rows} suite={suite} />
    {rows.length > 0 && <section className={panelClass} aria-label="Coding benchmark results"><BenchmarkTable rows={rows} suite={suite} /></section>}
  </div>;
}
