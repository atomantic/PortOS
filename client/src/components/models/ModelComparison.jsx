import { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { getModelComparison } from '../../services/apiModelComparison';
import { formatCount, formatUsd } from '../../utils/formatters';

const COLORS = ['#2563eb', '#f97316', '#16a34a', '#9333ea', '#0891b2', '#db2777', '#ca8a04'];
const PRICE_METRICS = [
  { id: 'outputPerMillion', label: 'Output price', axis: 'Published output price (USD per 1M tokens)' },
  { id: 'inputPerMillion', label: 'Input price', axis: 'Published input price (USD per 1M tokens)' },
];

const metricDate = metric => metric?.source?.retrievedAt?.slice(0, 10) || '—';
const hasPublicPrice = row => Boolean(row.inputPerMillion || row.outputPerMillion);
const hasFamilyPrice = metric => /family-level/i.test(metric?.source?.methodology || '');

function SourceLink({ metric, label = 'Source' }) {
  if (!metric?.source?.url) return '—';
  return (
    <a className="text-port-accent underline underline-offset-2" href={metric.source.url} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

function ComparisonTooltip({ active, payload, priceMetric }) {
  const row = payload?.[0]?.payload;
  const priceName = priceMetric.label.toLowerCase();
  if (!active || !row) return null;
  return (
    <div className="max-w-xs rounded-lg border border-port-border bg-port-card p-3 text-sm shadow-lg">
      <div className="font-semibold">{row.model}</div>
      <div className="text-port-text-muted">{row.provider} · {row.effort}</div>
      <div>{formatCount(row.y)}% benchmark score</div>
      <div>{row.familyRate ? '~' : ''}{formatUsd(row.x)} / 1M tokens ({priceName})</div>
      <div className="text-port-text-muted">Score sourced {metricDate(row.quality)}</div>
      <div className="text-port-text-muted">Price sourced {metricDate(row[priceMetric.id])}</div>
    </div>
  );
}

export default function ModelComparison() {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [benchmark, setBenchmark] = useState('');
  const [priceMetricId, setPriceMetricId] = useState('outputPerMillion');

  useEffect(() => {
    getModelComparison({ silent: true })
      .then(setCatalog)
      .catch(err => setError(err.message || 'Could not load the comparison data shipped with this PortOS release.'))
      .finally(() => setLoading(false));
  }, []);

  const observations = catalog?.observations || [];
  const benchmarks = useMemo(
    () => [...new Set(observations.filter(row => row.quality).map(row => row.benchmark))].sort(),
    [observations],
  );

  useEffect(() => {
    if (benchmarks.length && !benchmarks.includes(benchmark)) setBenchmark(benchmarks[0]);
  }, [benchmark, benchmarks]);

  const priceMetric = PRICE_METRICS.find(metric => metric.id === priceMetricId) || PRICE_METRICS[0];
  const scoredRows = useMemo(
    () => observations
      .filter(row => row.benchmark === benchmark && row.quality)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort)),
    [benchmark, observations],
  );
  const plotted = useMemo(() => scoredRows
    .filter(row => row[priceMetric.id])
    .map(row => ({
      ...row,
      x: row[priceMetric.id].value,
      y: row.quality.value,
      familyRate: hasFamilyPrice(row[priceMetric.id]),
    })), [priceMetric.id, scoredRows]);
  const grouped = useMemo(() => {
    const providers = [...new Set(plotted.map(row => row.provider))];
    return providers.map((name, index) => ({
      name,
      color: COLORS[index % COLORS.length],
      rows: plotted.filter(row => row.provider === name),
    }));
  }, [plotted]);

  const pricingOnlyRows = useMemo(
    () => observations.filter(row => !row.quality && hasPublicPrice(row))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
    [observations],
  );

  if (loading && !catalog) {
    return <div role="status" className="p-6 text-sm text-port-text-muted">Loading shipped model comparison data…</div>;
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 md:p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold"><BarChart3 size={24} /> Model comparison</h1>
        <p className="mt-1 max-w-4xl text-sm text-port-text-muted">
          Public benchmark results and token prices collected online and shipped with this PortOS release. This page reads the shipped snapshot; it does not discover providers or run models.
        </p>
      </header>

      {error && <p role="alert" className="rounded-lg border border-port-error/40 bg-port-error/10 p-3 text-sm text-port-error">{error}</p>}

      <section className="rounded-xl border border-port-border bg-port-card p-4 md:p-5" aria-labelledby="comparison-chart-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="comparison-chart-title" className="text-lg font-semibold">Published token price vs. benchmark performance</h2>
            <p className="text-sm text-port-text-muted">Each point uses one public score and the selected model’s published API rate. Prices are per 1M tokens, not measured task costs or subscription charges.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <div>
              <label htmlFor="comparison-benchmark" className="mb-1 block text-xs font-medium text-port-text-muted">Benchmark</label>
              <select id="comparison-benchmark" value={benchmark} onChange={event => setBenchmark(event.target.value)} disabled={benchmarks.length === 0} className="min-w-60 rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm">
                {benchmarks.length === 0 && <option value="">No scored benchmark data</option>}
                {benchmarks.map(value => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="comparison-price-metric" className="mb-1 block text-xs font-medium text-port-text-muted">Token price</label>
              <select id="comparison-price-metric" value={priceMetricId} onChange={event => setPriceMetricId(event.target.value)} className="rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm">
                {PRICE_METRICS.map(metric => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        {plotted.length === 0 ? (
          <div className="flex min-h-64 items-center justify-center rounded-lg border border-dashed border-port-border px-4 text-center text-sm text-port-text-muted">
            No models in this benchmark currently have a sourced {priceMetric.label.toLowerCase()}. The benchmark scores remain available in the table below.
          </div>
        ) : (
          <>
            <div className="h-[420px] w-full" role="img" aria-label={`${benchmark}: published token price versus benchmark score`}>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 12, right: 20, bottom: 28, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--port-border)" />
                  <XAxis type="number" dataKey="x" name={priceMetric.label} tickFormatter={value => formatUsd(value)} label={{ value: priceMetric.axis, position: 'insideBottom', offset: -14 }} />
                  <YAxis type="number" dataKey="y" name="Benchmark score" domain={[0, 100]} tickFormatter={value => `${value}%`} label={{ value: 'Benchmark score (%)', angle: -90, position: 'insideLeft' }} />
                  <Tooltip content={<ComparisonTooltip priceMetric={priceMetric} />} />
                  {grouped.map(group => <Scatter key={group.name} name={group.name} data={group.rows} fill={group.color} />)}
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-port-text-muted" aria-label="Chart legend">
              {grouped.map(group => <span key={group.name} className="inline-flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: group.color }} />{group.name}</span>)}
            </div>
          </>
        )}
        <p className="mt-3 text-xs text-port-text-muted">Some rates are published for a model family rather than the exact dated benchmark snapshot; those chart points are marked with ~. A missing rate is left blank, and a free endpoint’s published $0 rate does not promise unlimited use.</p>
      </section>

      <section className="rounded-xl border border-port-border bg-port-card p-4 md:p-5" aria-labelledby="benchmark-results-title">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="benchmark-results-title" className="text-lg font-semibold">Shipped benchmark results</h2>
            <p className="text-sm text-port-text-muted">Scores and pricing retain separate source links and retrieval dates.</p>
          </div>
          <span className="text-sm text-port-text-muted">{scoredRows.length} configurations · {plotted.length} with this price</span>
        </div>
        {scoredRows.length === 0 ? (
          <p className="text-sm text-port-text-muted">No scored rows are shipped for this benchmark yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-port-border text-xs uppercase text-port-text-muted">
                <tr><th className="py-2 pr-3">Provider / model</th><th className="py-2 pr-3">Effort</th><th className="py-2 pr-3">Score</th><th className="py-2 pr-3">Input / 1M</th><th className="py-2 pr-3">Output / 1M</th><th className="py-2 pr-3">Score source</th><th className="py-2 pr-3">Rate source</th></tr>
              </thead>
              <tbody>
                {scoredRows.map(row => (
                  <tr key={row.id} className="border-b border-port-border/60 last:border-0">
                    <td className="py-2 pr-3"><span className="font-medium">{row.model}</span><span className="block text-xs text-port-text-muted">{row.provider}</span></td>
                    <td className="py-2 pr-3">{row.effort === 'unspecified' ? '—' : row.effort}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{formatCount(row.quality.value)}%</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{row.inputPerMillion ? `${hasFamilyPrice(row.inputPerMillion) ? '~' : ''}${formatUsd(row.inputPerMillion.value)}` : '—'}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{row.outputPerMillion ? `${hasFamilyPrice(row.outputPerMillion) ? '~' : ''}${formatUsd(row.outputPerMillion.value)}` : '—'}</td>
                    <td className="py-2 pr-3 whitespace-nowrap"><SourceLink metric={row.quality} /> <span className="text-xs text-port-text-muted">{metricDate(row.quality)}</span></td>
                    <td className="py-2 pr-3 whitespace-nowrap"><SourceLink metric={row[priceMetric.id]} label={row[priceMetric.id] ? 'Source' : '—'} />{row[priceMetric.id] && <span className="ml-1 text-xs text-port-text-muted">{metricDate(row[priceMetric.id])}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-port-border bg-port-card p-4 md:p-5" aria-labelledby="pricing-only-title">
        <h2 id="pricing-only-title" className="mb-1 text-lg font-semibold">Pricing without benchmark results</h2>
        <p className="mb-3 text-sm text-port-text-muted">These are public price and free-endpoint references. PortOS has no matched public score for these exact model configurations yet.</p>
        {pricingOnlyRows.length === 0 ? (
          <p className="text-sm text-port-text-muted">No pricing-only records are shipped.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="border-b border-port-border text-xs uppercase text-port-text-muted">
                <tr><th className="py-2 pr-3">Provider / model</th><th className="py-2 pr-3">Input / 1M</th><th className="py-2 pr-3">Output / 1M</th><th className="py-2 pr-3">Reference</th><th className="py-2 pr-3">Source</th></tr>
              </thead>
              <tbody>
                {pricingOnlyRows.map(row => {
                  const rate = row.inputPerMillion || row.outputPerMillion;
                  return (
                    <tr key={row.id} className="border-b border-port-border/60 last:border-0">
                      <td className="py-2 pr-3"><span className="font-medium">{row.model}</span><span className="block text-xs text-port-text-muted">{row.provider}</span></td>
                      <td className="py-2 pr-3">{row.inputPerMillion ? `${hasFamilyPrice(row.inputPerMillion) ? '~' : ''}${formatUsd(row.inputPerMillion.value)}` : '—'}</td>
                      <td className="py-2 pr-3">{row.outputPerMillion ? `${hasFamilyPrice(row.outputPerMillion) ? '~' : ''}${formatUsd(row.outputPerMillion.value)}` : '—'}</td>
                      <td className="py-2 pr-3">{row.benchmark}</td>
                      <td className="py-2 pr-3 whitespace-nowrap"><SourceLink metric={rate} /> <span className="text-xs text-port-text-muted">{metricDate(rate)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
