import { useMemo, useState } from 'react';
import { formatCount, formatPercent, formatUsd } from '../../utils/formatters';

const number = value => formatCount(value, { maximumFractionDigits: 2 });
const cost = value => formatUsd(value, { maximumFractionDigits: 4 });
const label = row => `${row.model} (${row.effort})`;
const savings = (before, after) => before === after ? 'Same cost' : before > 0 ? `${formatPercent((before - after) / before * 100, { decimals: 1 })} less` : 'Same cost';

/** Recommendations use one published workload, never a guessed effort multiplier. */
export default function ComparisonValueGuide({ rows }) {
  const [tolerance, setTolerance] = useState(1);
  const [limit, setLimit] = useState(20);
  const eligible = useMemo(() => [...new Map(rows.filter(row => row.quality && row.costPerTask && !row.quality.estimated && !row.costPerTask.estimated)
    .map(row => [`${row.model}:${row.effort}:${row.quality.value}:${row.costPerTask.value}`, row])).values()], [rows]);
  const models = [...new Set(rows.map(row => row.model))].sort();
  const byCost = [...eligible].sort((a, b) => a.costPerTask.value - b.costPerTask.value || b.quality.value - a.quality.value || label(a).localeCompare(label(b)));
  const alternative = row => byCost.find(other => other.model !== row.model && other.costPerTask.value < row.costPerTask.value && other.quality.value >= row.quality.value - tolerance);
  const guide = models.map(model => {
    const points = byCost.filter(row => row.model === model);
    const best = points.reduce((result, row) => !result || row.quality.value > result.quality.value ? row : result, null);
    const pick = best && points.find(row => row.quality.value >= best.quality.value - tolerance);
    return { model, points, best, pick, peer: pick && alternative(pick) };
  });
  return <section className="min-w-0 rounded-xl border border-port-border bg-port-card p-4 space-y-3" aria-label="Effort value guide">
    <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="font-semibold">Which efforts are worth the cost?</h2><p className="text-sm text-port-text-muted">Cheapest effort within your tolerance of each model’s best selected score.</p></div>
      <div><label className="block text-xs mb-1" htmlFor="comparison-tolerance">Acceptable intelligence difference</label><select id="comparison-tolerance" className="max-w-full rounded-lg border border-port-border bg-port-bg p-2 text-sm" value={tolerance} onChange={event => setTolerance(Number(event.target.value))}>{[0, 0.5, 1, 2, 3, 5].map(value => <option key={value} value={value}>{number(value)} index points</option>)}</select></div></div>
    <p className="text-xs text-port-text-muted">Uses sourced Intelligence Index task costs across the selected models and efforts, regardless of the chart’s token-price axis. Estimates are excluded. A near match is a score tradeoff, not proof of equal ability; latency, coding, tools, context and reliability can still favor another choice. These API reference costs may differ from your endpoint or subscription.</p>
    <div className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">{guide.slice(0, limit).map(({ model, points, best, pick, peer }) => <article key={model} className="min-w-0 rounded-lg border border-port-border p-3">
      <h3 className="font-medium break-all">{model}</h3>
      {!pick ? <p className="mt-2 text-sm text-port-text-muted">Research needed: no selected effort has both a sourced score and task cost.</p> : <>
        <p className="mt-2 text-sm"><strong>{pick.effort}</strong> · {number(pick.quality.value)} points · {cost(pick.costPerTask.value)}/task</p>
        <p className="text-xs text-port-text-muted">{points.length === 1 ? 'Only one measured effort selected; no effort optimum established.' : `${number(best.quality.value - pick.quality.value)} points below best selected (${best.effort}); ${savings(best.costPerTask.value, pick.costPerTask.value)} compared with that effort.`}</p>
        {peer ? <p className="mt-2 text-sm break-words">Cheaper peer: <strong>{label(peer)}</strong> · {cost(peer.costPerTask.value)}/task · {savings(pick.costPerTask.value, peer.costPerTask.value)} · {number(peer.quality.value - pick.quality.value)} points difference.</p> : <p className="mt-2 text-xs text-port-text-muted">No cheaper measured peer within your tolerance among the selected configurations.</p>}
        <details className="mt-2"><summary className="cursor-pointer text-sm">Effort tradeoffs ({formatCount(points.length)})</summary><ul className="mt-2 space-y-2 text-xs">{points.map(row => {
          const cheaper = byCost.find(other => other.id !== row.id && other.costPerTask.value <= row.costPerTask.value && other.quality.value >= row.quality.value && (other.costPerTask.value < row.costPerTask.value || other.quality.value > row.quality.value));
          const near = !cheaper && byCost.find(other => other.costPerTask.value < row.costPerTask.value && other.quality.value >= row.quality.value - tolerance);
          return <li key={row.id} className="break-words"><strong>{row.effort}</strong>: {number(row.quality.value)} points, {cost(row.costPerTask.value)}/task. {cheaper ? `Better measured cost/performance: ${label(cheaper)} at ${cost(cheaper.costPerTask.value)}/task.` : near ? `Near match for less: ${label(near)} at ${cost(near.costPerTask.value)}/task (${number(row.quality.value - near.quality.value)} points lower).` : 'On the measured cost/performance frontier of this selection.'}</li>;
        })}</ul></details>
      </>}
    </article>)}</div>
    {guide.length > limit && <button className="rounded-lg border border-port-border px-3 py-2 text-xs" onClick={() => setLimit(value => value + 20)}>Show 20 more models</button>}
  </section>;
}
