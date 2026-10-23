import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Link } from 'react-router';
import { formatCount, formatCompactCount, formatMonthYear, formatUsd } from '../../utils/formatters';

const spendColor = 'rgb(var(--port-chart-2))';
const tokenColor = 'rgb(var(--port-chart-3))';
const monthLabel = (month) => formatMonthYear(`${month}-01`);
const compactUsd = (value) => formatUsd(value, { compact: true });

export default function MonthlyUsageCard({ history = [], savings }) {
  const configured = savings?.configured === true;
  const points = history.map((point) => ({
    ...point,
    spend: configured ? savings.totals.monthlyCost : null,
  }));

  return (
    <section className="min-w-0 bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3" aria-label="Monthly spend and tokens">
      <h3 className="text-sm font-medium text-gray-400">Monthly subscription spend &amp; tokens</h3>
      <p className="text-xs text-gray-500">
        Last 12 calendar months, independent of the report filter. Bars show the full monthly subscription budget at your current prices, not historical invoices or API charges. Only plans with configured prices are included.
        {' '}The line shows this machine&rsquo;s recorded input, output and cache tokens; counts may include estimates. The current and first recorded months may have partial token history.
      </p>
      {!configured && <p className="text-sm text-gray-400"><Link to="/models/subscriptions" className="text-port-accent underline">Set subscription prices</Link> to show dollar spend. Missing prices are not treated as zero.</p>}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-400">
        <span style={{ color: spendColor }}>■ Subscription budget (USD, left axis)</span>
        <span style={{ color: tokenColor }}>━ Tokens (right axis)</span>
      </div>
      {points.length === 0 ? <p className="text-sm text-gray-500">No monthly usage recorded yet.</p> : <>
        <div className="h-64 min-w-0" role="img" aria-label="Monthly subscription budget bars with token trend; exact values in the table below">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="rgb(var(--port-border))" strokeDasharray="3 3" />
              <XAxis dataKey="month" tickFormatter={monthLabel} minTickGap={30} tick={{ fontSize: 10 }} />
              <YAxis yAxisId="spend" tickFormatter={compactUsd} width={55} tick={{ fontSize: 10 }} domain={[0, 'auto']} />
              <YAxis yAxisId="tokens" orientation="right" tickFormatter={formatCompactCount} width={50} tick={{ fontSize: 10 }} domain={[0, 'auto']} />
              <Tooltip labelFormatter={monthLabel} formatter={(value, name) => [name === 'Subscription budget' ? formatUsd(value) : formatCount(value), name]} contentStyle={{ background: 'rgb(var(--port-card))', borderColor: 'rgb(var(--port-border))' }} />
              <Bar yAxisId="spend" dataKey="spend" name="Subscription budget" fill={spendColor} maxBarSize={36} isAnimationActive={false} />
              <Line yAxisId="tokens" dataKey="tokens" name="Tokens" stroke={tokenColor} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer py-2">Monthly values</summary>
          <table className="w-full text-left tabular-nums">
            <thead><tr><th className="py-2">Month</th><th>Budget (USD)</th><th>Tokens</th></tr></thead>
            <tbody>{points.map((point) => <tr key={point.month}>
              <th className="py-2 font-normal">{monthLabel(point.month)}{point.partial ? ' (partial)' : ''}</th>
              <td>{configured ? formatUsd(point.spend) : 'Not configured'}</td>
              <td>{formatCount(point.tokens)}</td>
            </tr>)}</tbody>
          </table>
        </details>
      </>}
    </section>
  );
}
