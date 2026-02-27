import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';

export default function MetricCard({ data = [], loading = false, config, latestValue }) {
  const { label, unit, color, aggregation, formatValue } = config;
  const isSumMetric = aggregation === 'sum';

  const summary = data.length > 0
    ? (isSumMetric
      ? Math.round(data.reduce((sum, d) => sum + (d.value ?? 0), 0) / data.length)
      : Math.round(data.reduce((sum, d) => sum + (d.value ?? 0), 0) / data.length * 100) / 100)
    : null;

  const displayValue = summary != null
    ? (formatValue ? formatValue(summary) : (Number.isInteger(summary) ? summary.toLocaleString() : summary))
    : null;

  const chartData = data.map(d => ({
    date: d.date?.slice(5) ?? d.date,
    value: d.value ?? 0
  }));

  const summaryLabel = isSumMetric ? `avg daily ${unit}` : unit;

  // Show latest recorded value when no data in current range
  const showLatest = displayValue == null && latestValue?.date;
  const latestDisplay = showLatest
    ? (formatValue ? formatValue(latestValue.value) : latestValue.value)
    : null;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">{label}</h3>
      {loading ? (
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">Loading...</div>
      ) : showLatest ? (
        <div className="flex flex-col items-center justify-center h-40">
          <span className="text-3xl font-bold text-white font-mono">{latestDisplay}</span>
          <span className="text-sm text-gray-500 mt-1">{unit}</span>
          <span className="text-xs text-gray-600 mt-2">last recorded {latestValue.date}</span>
        </div>
      ) : displayValue == null ? (
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">No {label.toLowerCase()} data available</div>
      ) : (
        <>
          <div className="mb-4">
            <span className="text-3xl font-bold text-white font-mono">{displayValue}</span>
            <span className="text-sm text-gray-500 ml-2">{summaryLabel}</span>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={chartData} margin={{ top: 2, right: 8, bottom: 2, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
              <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} width={55} domain={['auto', 'auto']}
                tickFormatter={v => typeof v === 'number' && v >= 1000 ? v.toLocaleString() : v} />
              <Tooltip content={({ active, payload, label: tipLabel }) => {
                if (!active || !payload?.length) return null;
                const val = payload[0].value;
                const formatted = formatValue ? formatValue(val) : (typeof val === 'number' && val >= 1000 ? val.toLocaleString() : Math.round(val * 100) / 100);
                return (
                  <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#fff', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
                    <p style={{ color: '#9ca3af', marginBottom: 2 }}>{tipLabel}</p>
                    <p style={{ color, fontWeight: 600 }}>{formatted} {unit}</p>
                  </div>
                );
              }} />
              <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}
