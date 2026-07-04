import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import * as api from '../../services/api';
import BrailleSpinner from '../BrailleSpinner';
import useChartColors from '../../hooks/useChartColors.js';
import { localDateStr } from './constants';

const VIEWS = [
  { id: '7d', label: '7 Days', days: 7 },
  { id: '30d', label: '30 Days', days: 30 },
  { id: '90d', label: '90 Days', days: 90 }
];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  const mg = payload[0].payload.mg;
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-2 text-sm">
      <p className="text-gray-400">{label}</p>
      <p className={`font-semibold ${mg > 20 ? 'text-port-warning' : 'text-white'}`}>
        {mg} mg
      </p>
    </div>
  );
};

export default function NicotineChart({ onRefreshKey, onViewChange }) {
  const chartColors = useChartColors();
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('30d');

  const fetchData = useCallback(async () => {
    const days = VIEWS.find(v => v.id === view)?.days || 30;
    const from = new Date();
    from.setDate(from.getDate() - days);
    const fromStr = localDateStr(from);
    const toStr = localDateStr();

    const entries = await api.getDailyNicotine(fromStr, toStr).catch(() => []);

    const chartData = [];
    const dateMap = {};
    for (const entry of entries) {
      dateMap[entry.date] = entry.nicotine?.totalMg || 0;
    }

    const cursor = new Date(from);
    let dateStr = localDateStr(cursor);
    while (dateStr <= toStr) {
      const mg = dateMap[dateStr] || 0;
      chartData.push({
        date: dateStr,
        label: `${cursor.getMonth() + 1}/${cursor.getDate()}`,
        mg
      });
      cursor.setDate(cursor.getDate() + 1);
      dateStr = localDateStr(cursor);
    }

    setData(chartData);
    setLoading(false);
  }, [view]);

  useEffect(() => {
    fetchData();
  }, [fetchData, onRefreshKey]);

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
          Daily Consumption
        </h3>
        <div className="flex gap-1">
          {VIEWS.map(v => (
            <button
              key={v.id}
              onClick={() => { setView(v.id); onViewChange?.(v.id); }}
              className={`px-2 py-1 min-h-[40px] text-xs rounded transition-colors ${
                view === v.id
                  ? 'bg-port-accent/10 text-port-accent'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <BrailleSpinner text="Loading chart" />
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={250}>
          <BarChart data={data} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
            <XAxis
              dataKey="label"
              tick={{ fill: chartColors.axis, fontSize: 11 }}
              interval={view === '7d' ? 0 : view === '30d' ? 2 : 6}
            />
            <YAxis tick={{ fill: chartColors.axis, fontSize: 11 }} label={{ value: 'mg', angle: -90, position: 'insideLeft', fill: chartColors.axis, fontSize: 10 }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar
              dataKey="mg"
              radius={[2, 2, 0, 0]}
              fill={chartColors.axis}
              maxBarSize={view === '7d' ? 40 : view === '30d' ? 16 : 8}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
