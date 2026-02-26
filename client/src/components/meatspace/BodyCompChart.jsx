import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import * as api from '../../services/api';
import BrailleSpinner from '../BrailleSpinner';

export default function BodyCompChart() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const history = await api.getBodyHistory().catch(() => []);
    const chartData = history.map(entry => ({
      date: entry.date,
      label: `${new Date(entry.date).getMonth() + 1}/${new Date(entry.date).getDate()}`,
      weight: entry.weightLbs || null,
      fatPct: entry.fatPct || null,
      musclePct: entry.musclePct || null
    })).filter(d => d.weight !== null);
    setData(chartData);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <div className="flex justify-center py-8">
          <BrailleSpinner text="Loading chart" />
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl p-6">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-2">Body Composition</h3>
        <p className="text-gray-500 text-sm">No body composition data. Import your health spreadsheet to see trends.</p>
      </div>
    );
  }

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-2 text-sm">
        <p className="text-gray-400 mb-1">{label}</p>
        {payload.map(p => (
          <p key={p.dataKey} style={{ color: p.color }}>
            {p.name}: {p.value}{p.dataKey === 'weight' ? ' lbs' : '%'}
          </p>
        ))}
      </div>
    );
  };

  // Determine Y axes
  const hasBodyFat = data.some(d => d.fatPct);

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-4">
        Body Composition Over Time
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
          <XAxis
            dataKey="label"
            tick={{ fill: '#6b7280', fontSize: 11 }}
            interval={Math.max(0, Math.floor(data.length / 12))}
          />
          <YAxis
            yAxisId="weight"
            tick={{ fill: '#6b7280', fontSize: 11 }}
            domain={['dataMin - 5', 'dataMax + 5']}
          />
          {hasBodyFat && (
            <YAxis
              yAxisId="pct"
              orientation="right"
              tick={{ fill: '#6b7280', fontSize: 11 }}
              domain={[0, 50]}
            />
          )}
          <Tooltip content={<CustomTooltip />} />
          <Legend />
          <Line
            yAxisId="weight"
            type="monotone"
            dataKey="weight"
            name="Weight (lbs)"
            stroke="#3b82f6"
            dot={false}
            strokeWidth={2}
            connectNulls
          />
          {hasBodyFat && (
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="fatPct"
              name="Body Fat %"
              stroke="#ef4444"
              dot={false}
              strokeWidth={2}
              connectNulls
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
