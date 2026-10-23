import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { formatCount, formatCompactCount, formatMonthYear, formatUsd } from '../../utils/formatters';
import { seriesColors } from '../../lib/usageChartColors';

const costColor = 'rgb(var(--port-chart-2))';
const tokenColor = 'rgb(var(--port-text))';
const monthLabel = (month) => formatMonthYear(`${month}-01T00:00:00`);
const compactUsd = (value) => formatUsd(value, { compact: true });

export default function MonthlyUsageCard({ history: points = [], series = [], instanceCount = 1 }) {
  const colors = seriesColors(series);
  return (
    <section className="min-w-0 bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3" aria-label="Monthly estimated API cost and tokens">
      <h3 className="text-sm font-medium text-gray-400">Monthly estimated API cost &amp; tokens</h3>
      <p className="text-xs text-gray-500">
        Last 12 UTC calendar months across {instanceCount > 1 ? `${formatCount(instanceCount)} instances` : 'this machine'}, including Claude Code transcripts, with the same coverage as the rolling chart. Independent of the report filter.
        {' '}Calendar months differ from a trailing 30-day window. The current and first recorded months may be partial; peer history reflects its last sync. The line includes input, output and cache tokens, including estimates.
      </p>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-400">
        {series.length > 0 ? series.map((provider, i) => (
          <span key={provider.key} style={{ color: colors[i] }}>■ {provider.label} (USD)</span>
        )) : <span style={{ color: costColor }}>■ Est. API cost (USD, left axis)</span>}
        <span style={{ color: tokenColor }}>━ Tokens (right axis)</span>
      </div>
      {points.length === 0 ? <p className="text-sm text-gray-500">No monthly usage recorded yet.</p> : <>
        <div className="h-64 min-w-0" role="img" aria-label="Monthly estimated API cost stacked by provider with token trend; exact values in the table below">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="rgb(var(--port-border))" strokeDasharray="3 3" />
              <XAxis dataKey="month" tickFormatter={monthLabel} minTickGap={30} tick={{ fontSize: 10 }} />
              <YAxis yAxisId="cost" tickFormatter={compactUsd} width={55} tick={{ fontSize: 10 }} domain={[0, 'auto']} />
              <YAxis yAxisId="tokens" orientation="right" tickFormatter={formatCompactCount} width={50} tick={{ fontSize: 10 }} domain={[0, 'auto']} />
              <Tooltip labelFormatter={monthLabel} formatter={(value, name, item) => [item.dataKey === 'tokens' ? formatCount(value) : formatUsd(value), name]} contentStyle={{ background: 'rgb(var(--port-card))', borderColor: 'rgb(var(--port-border))' }} />
              {series.length > 0 ? series.map((provider, i) => (
                <Bar key={provider.key} yAxisId="cost" dataKey={`values[${i}]`} stackId="cost" name={provider.label} fill={colors[i]} maxBarSize={36} isAnimationActive={false} />
              )) : <Bar yAxisId="cost" dataKey="estimatedCost" name="Est. API cost" fill={costColor} maxBarSize={36} isAnimationActive={false} />}
              <Line yAxisId="tokens" dataKey="tokens" name="Tokens" stroke={tokenColor} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer py-2">Monthly values</summary>
          <div className="overflow-x-auto">
            <table className="w-full text-left tabular-nums whitespace-nowrap">
              <thead><tr>
                <th className="py-2 pr-3">Month</th>
                {series.map((provider) => <th key={provider.key} className="pr-3">{provider.label} (USD)</th>)}
                <th className="pr-3">Est. cost (USD)</th><th>Tokens</th>
              </tr></thead>
              <tbody>{points.map((point) => <tr key={point.month}>
                <th className="py-2 pr-3 font-normal">{monthLabel(point.month)}{point.partial ? ' (partial)' : ''}</th>
                {series.map((provider, i) => <td key={provider.key} className="pr-3">{formatUsd(point.values?.[i])}</td>)}
                <td className="pr-3">{formatUsd(point.estimatedCost)}</td>
                <td>{formatCount(point.tokens)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </details>
      </>}
    </section>
  );
}
