import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';

const STAGE_COLORS = {
  deep: '#3b82f6',
  rem: '#8b5cf6',
  core: '#06b6d4',
  awake: '#6b7280'
};

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#fff', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
      <p style={{ color: '#9ca3af', marginBottom: 4 }}>{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} style={{ color: entry.fill, margin: '2px 0' }}>
          {entry.name}: {entry.value != null ? entry.value.toFixed(1) : '—'}h
        </p>
      ))}
    </div>
  );
};

export default function SleepCard({ data = [], loading = false }) {
  const avg = data.length > 0
    ? (data.reduce((sum, d) => sum + (d.totalSleep ?? d.value ?? 0), 0) / data.length)
    : null;

  // Show only last 7 days in stacked bar chart
  const last7 = data.slice(-7).map(d => ({
    date: d.date?.slice(5) ?? d.date,
    deep: d.deep ?? 0,
    rem: d.rem ?? 0,
    core: d.core ?? 0,
    awake: d.awake ?? 0
  }));

  const hasStages = last7.some(d => d.deep > 0 || d.rem > 0 || d.core > 0);

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">Sleep</h3>
      {loading ? (
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">Loading...</div>
      ) : avg == null ? (
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">No sleep data available</div>
      ) : (
        <>
          <div className="mb-4">
            <span className="text-3xl font-bold text-white font-mono">{avg.toFixed(1)}</span>
            <span className="text-sm text-gray-500 ml-2">avg hrs / night</span>
          </div>
          {hasStages ? (
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={last7} layout="vertical" margin={{ top: 2, right: 8, bottom: 2, left: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" horizontal={false} />
                <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 11 }} unit="h" />
                <YAxis type="category" dataKey="date" tick={{ fill: '#9ca3af', fontSize: 10 }} width={36} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
                <Bar dataKey="deep" name="Deep" stackId="a" fill={STAGE_COLORS.deep} />
                <Bar dataKey="rem" name="REM" stackId="a" fill={STAGE_COLORS.rem} />
                <Bar dataKey="core" name="Core" stackId="a" fill={STAGE_COLORS.core} />
                <Bar dataKey="awake" name="Awake" stackId="a" fill={STAGE_COLORS.awake} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-gray-600 text-xs">Sleep stage breakdown not available</div>
          )}
        </>
      )}
    </div>
  );
}
