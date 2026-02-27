import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';

// Blood markers to chart — prefer common ones if available in the test results
const PREFERRED_MARKERS = ['cholesterol', 'glucose', 'ldl', 'hdl', 'triglycerides'];

function compute30DayRollingAvg(dailyData, testDate) {
  const windowStart = new Date(testDate);
  windowStart.setDate(windowStart.getDate() - 30);
  const startStr = windowStart.toISOString().split('T')[0];

  const window = dailyData.filter(d => d.date >= startStr && d.date < testDate && d.steps != null);
  if (window.length === 0) return null;
  return Math.round(window.reduce((sum, d) => sum + d.steps, 0) / window.length);
}

function pickMarkers(bloodTests) {
  // Find which preferred markers appear in any test
  const found = [];
  for (const marker of PREFERRED_MARKERS) {
    if (bloodTests.some(t => t.results?.[marker] != null || t[marker] != null)) {
      found.push(marker);
      if (found.length === 3) break;
    }
  }
  return found;
}

const MARKER_COLORS = ['#3b82f6', '#8b5cf6', '#f59e0b'];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#fff', padding: '8px', borderRadius: '6px', fontSize: '12px' }}>
      <p style={{ color: '#9ca3af', marginBottom: 4 }}>{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} style={{ color: entry.color ?? entry.fill, margin: '2px 0' }}>
          {entry.name}: {entry.value != null ? Math.round(entry.value).toLocaleString() : '—'}
          {entry.dataKey === 'steps' ? ' steps/day' : ''}
        </p>
      ))}
    </div>
  );
};

export default function ActivityBloodCorrelation({ data, range }) {
  const dailyData = data?.dailyData ?? [];
  const bloodTests = data?.bloodTests ?? [];

  if (dailyData.length < 14) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Activity vs Blood Work</h3>
        <p className="text-gray-400 text-sm">
          Need 14+ days of data for correlations — {dailyData.length} days so far.
        </p>
      </div>
    );
  }

  if (bloodTests.length === 0) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">Activity vs Blood Work</h3>
        <p className="text-gray-400 text-sm">No blood tests in this period to correlate with activity.</p>
      </div>
    );
  }

  const markers = pickMarkers(bloodTests);

  // Build chart data: one entry per blood test
  const chartData = bloodTests.map(test => {
    const stepsAvg = compute30DayRollingAvg(dailyData, test.date);
    const entry = {
      date: test.date?.slice(5) ?? test.date,
      fullDate: test.date,
      steps: stepsAvg
    };
    for (const marker of markers) {
      entry[marker] = test.results?.[marker] ?? test[marker] ?? null;
    }
    return entry;
  });

  // Build a summary sentence for each test
  const summaries = bloodTests.map(test => {
    const avg = compute30DayRollingAvg(dailyData, test.date);
    if (avg == null) return null;
    return `Average ${avg.toLocaleString()} steps/day in the 30 days before your ${test.date} blood test`;
  }).filter(Boolean);

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Activity vs Blood Work</h3>
        <span className="text-xs text-gray-600 ml-1">({range})</span>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 40, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis dataKey="date" tick={{ fill: '#9ca3af', fontSize: 11 }} />
          <YAxis
            yAxisId="steps"
            orientation="left"
            tick={{ fill: '#9ca3af', fontSize: 11 }}
            width={60}
            tickFormatter={v => v.toLocaleString()}
            label={{ value: 'Steps (30d avg)', angle: -90, position: 'insideLeft', fill: '#9ca3af', fontSize: 10 }}
          />
          {markers.length > 0 && (
            <YAxis
              yAxisId="markers"
              orientation="right"
              tick={{ fill: '#9ca3af', fontSize: 11 }}
              width={40}
              label={{ value: 'Blood (mg/dL)', angle: 90, position: 'insideRight', fill: '#9ca3af', fontSize: 10 }}
            />
          )}
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
          <Bar
            yAxisId="steps"
            dataKey="steps"
            name="30d Avg Steps"
            fill="#6b7280"
            opacity={0.6}
            maxBarSize={40}
          />
          {markers.map((marker, i) => (
            <Line
              key={marker}
              yAxisId="markers"
              type="monotone"
              dataKey={marker}
              name={marker.charAt(0).toUpperCase() + marker.slice(1)}
              stroke={MARKER_COLORS[i]}
              strokeWidth={2}
              dot={{ r: 4, fill: MARKER_COLORS[i] }}
              connectNulls
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      {summaries.length > 0 && (
        <div className="text-sm text-gray-400 mt-3 border-t border-port-border pt-3 space-y-1">
          {summaries.map((s, i) => <p key={i}>{s}</p>)}
        </div>
      )}
    </div>
  );
}
