import { HeartPulse, Cigarette } from 'lucide-react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import useChartColors from '../../hooks/useChartColors.js';

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-2 text-sm text-white">
      <p className="text-gray-400 mb-1">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} style={{ color: entry.color ?? entry.fill }} className="my-0.5">
          {entry.name}: {entry.value != null ? Math.round(entry.value * 100) / 100 : '\u2014'}
          {entry.dataKey === 'hr' || entry.dataKey === 'restingHr' ? ' bpm' : ' mg'}
        </p>
      ))}
    </div>
  );
};

function computeSummary(dailyData) {
  const nicotineDays = dailyData.filter(d => d.nicotineMg != null && d.nicotineMg > 0 && d.hr != null);
  const cleanDays = dailyData.filter(d => (d.nicotineMg == null || d.nicotineMg === 0) && d.hr != null);

  if (nicotineDays.length === 0) return 'No nicotine data recorded in this period.';
  if (cleanDays.length === 0) return 'No nicotine-free days recorded in this period.';

  const avgHrNicotine = Math.round(nicotineDays.reduce((sum, d) => sum + d.hr, 0) / nicotineDays.length);
  const avgHrClean = Math.round(cleanDays.reduce((sum, d) => sum + d.hr, 0) / cleanDays.length);
  const percentDiff = avgHrClean > 0
    ? Math.abs(((avgHrNicotine - avgHrClean) / avgHrClean) * 100).toFixed(0)
    : '0';

  const direction = avgHrNicotine > avgHrClean ? 'higher' : 'lower';

  return `Avg heart rate is ${avgHrNicotine} bpm on nicotine days vs ${avgHrClean} bpm on clean days (${percentDiff}% ${direction})`;
}

export default function NicotineHealthCorrelation({ data, range }) {
  const chartColors = useChartColors();
  const dailyData = data?.dailyData ?? [];

  if (dailyData.length < 14) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex items-center gap-2 mb-3">
          <HeartPulse size={16} className="text-port-error" />
          <Cigarette size={16} className="text-gray-400" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Nicotine vs Heart Rate</h3>
        </div>
        <p className="text-gray-400 text-sm">
          Need 14+ days of data for correlations — {dailyData.length} days so far.
        </p>
      </div>
    );
  }

  const chartData = dailyData.map(d => ({
    date: d.date?.slice(5) ?? '',
    hr: d.hr,
    restingHr: d.restingHr,
    nicotine: d.nicotineMg
  }));

  const summary = computeSummary(dailyData);

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <HeartPulse size={16} className="text-port-error" />
        <Cigarette size={16} className="text-gray-400" />
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">Nicotine vs Heart Rate</h3>
        <span className="text-xs text-gray-600 ml-1">({range})</span>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 40, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
          <XAxis dataKey="date" tick={{ fill: chartColors.axis, fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis
            yAxisId="hr"
            orientation="left"
            tick={{ fill: chartColors.axis, fontSize: 11 }}
            width={40}
            label={{ value: 'HR (bpm)', angle: -90, position: 'insideLeft', fill: chartColors.axis, fontSize: 10 }}
          />
          <YAxis
            yAxisId="nicotine"
            orientation="right"
            tick={{ fill: chartColors.axis, fontSize: 11 }}
            width={40}
            label={{ value: 'Nicotine (mg)', angle: 90, position: 'insideRight', fill: chartColors.axis, fontSize: 10 }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend wrapperStyle={{ fontSize: 11, color: chartColors.axis }} />
          <Line
            yAxisId="hr"
            type="monotone"
            dataKey="hr"
            name="Heart Rate"
            stroke={chartColors.error}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
          <Line
            yAxisId="hr"
            type="monotone"
            dataKey="restingHr"
            name="Resting HR"
            // Lighter red than chartColors.error — deliberately distinct from
            // the primary HR line, no matching --port-* token.
            stroke="#f87171"
            strokeWidth={1}
            strokeDasharray="4 2"
            dot={false}
            connectNulls
          />
          <Bar
            yAxisId="nicotine"
            dataKey="nicotine"
            name="Nicotine"
            fill={chartColors.axis}
            opacity={0.7}
            maxBarSize={12}
          />
        </ComposedChart>
      </ResponsiveContainer>

      <p className="text-sm text-gray-400 mt-3 border-t border-port-border pt-3">{summary}</p>
    </div>
  );
}
