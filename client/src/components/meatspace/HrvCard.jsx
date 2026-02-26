import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#fff', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
      <p style={{ color: '#9ca3af', marginBottom: 2 }}>{label}</p>
      <p style={{ color: '#22c55e', fontWeight: 600 }}>{Math.round(payload[0].value)} ms</p>
    </div>
  );
};

export default function HrvCard({ data = [], loading = false }) {
  const avg = data.length > 0
    ? Math.round(data.reduce((sum, d) => sum + (d.value ?? 0), 0) / data.length)
    : null;

  const chartData = data.map(d => ({
    date: d.date?.slice(5) ?? d.date,
    value: d.value ?? 0
  }));

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">HRV</h3>
      {loading ? (
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">Loading...</div>
      ) : avg == null ? (
        <div className="flex items-center justify-center h-40 text-gray-600 text-sm">No HRV data available</div>
      ) : (
        <>
          <div className="mb-4">
            <span className="text-3xl font-bold text-white font-mono">{avg}</span>
            <span className="text-sm text-gray-500 ml-2">ms</span>
          </div>
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={chartData} margin={{ top: 2, right: 8, bottom: 2, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
              <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 11 }} width={40} domain={['auto', 'auto']} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="value" stroke="#22c55e" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </div>
  );
}
