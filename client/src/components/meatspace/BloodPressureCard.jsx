import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine
} from 'recharts';
import { HeartPulse, Plus, X, Check, TrendingUp, TrendingDown } from 'lucide-react';
import * as api from '../../services/api';
import BrailleSpinner from '../BrailleSpinner';
import { classifyBP, bpLongevityImpact, BP_CATEGORIES } from './bpClassification';

const EMPTY_FORM = { date: '', systolic: '', diastolic: '' };

function parseNum(v) {
  if (v === '' || v == null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export default function BloodPressureCard() {
  const [readings, setReadings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchData = useCallback(async () => {
    const data = await api.getBloodPressure().catch(() => ({ readings: [] }));
    setReadings(data?.readings || []);
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openForm = () => {
    setForm({ ...EMPTY_FORM, date: new Date().toISOString().split('T')[0] });
    setShowForm(true);
  };

  const handleSave = async () => {
    const sys = parseNum(form.systolic);
    const dia = parseNum(form.diastolic);
    if (sys == null || dia == null || !form.date) return;
    setSaving(true);
    const reading = await api.addBloodPressure({ date: form.date, systolic: sys, diastolic: dia })
      .catch(() => null);
    setSaving(false);
    if (!reading) return;
    setReadings(prev => {
      const others = prev.filter(r => r.date !== reading.date);
      return [...others, reading].sort((a, b) => a.date.localeCompare(b.date));
    });
    setForm(EMPTY_FORM);
    setShowForm(false);
  };

  const chartData = readings.map(r => ({
    date: r.date,
    label: `${new Date(r.date).getMonth() + 1}/${new Date(r.date).getDate()}`,
    systolic: r.systolic,
    diastolic: r.diastolic
  }));

  const latest = readings.at(-1);
  const latestCategory = latest ? BP_CATEGORIES[classifyBP(latest.systolic, latest.diastolic)] : null;
  const impact = latest ? bpLongevityImpact(latest.systolic, latest.diastolic) : null;

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-2 text-sm">
        <p className="text-gray-400 mb-1">{label}</p>
        {payload.map(p => (
          <p key={p.dataKey} style={{ color: p.color }}>
            {p.name}: {p.value} mmHg
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <HeartPulse size={18} className="text-port-error" />
          <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">
            Blood Pressure ({loading ? '...' : readings.length})
          </h3>
        </div>
        {!showForm && (
          <button
            onClick={openForm}
            className="flex items-center gap-1 text-xs text-port-accent hover:text-blue-300 transition-colors"
          >
            <Plus size={14} /> Add Reading
          </button>
        )}
      </div>

      {showForm && (
        <div className="bg-port-bg border border-port-border rounded-lg p-4 mb-4">
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div>
              <label htmlFor="bp-date" className="text-xs text-gray-500">Date</label>
              <input
                id="bp-date" type="date" value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono"
              />
            </div>
            <div>
              <label htmlFor="bp-sys" className="text-xs text-gray-500">Systolic</label>
              <input
                id="bp-sys" type="number" inputMode="numeric" placeholder="120"
                value={form.systolic}
                onChange={e => setForm(f => ({ ...f, systolic: e.target.value }))}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono"
              />
            </div>
            <div>
              <label htmlFor="bp-dia" className="text-xs text-gray-500">Diastolic</label>
              <input
                id="bp-dia" type="number" inputMode="numeric" placeholder="80"
                value={form.diastolic}
                onChange={e => setForm(f => ({ ...f, diastolic: e.target.value }))}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-gray-200 font-mono"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !form.date || parseNum(form.systolic) == null || parseNum(form.diastolic) == null}
              className="flex items-center gap-1 px-3 py-1 bg-port-accent/20 text-port-accent rounded text-sm hover:bg-port-accent/30 disabled:opacity-40"
            >
              <Check size={14} /> {saving ? 'Saving…' : 'Save Reading'}
            </button>
            <button
              onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}
              className="flex items-center gap-1 px-3 py-1 text-gray-400 hover:text-gray-200 text-sm"
            >
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-8"><BrailleSpinner text="Loading blood pressure" /></div>
      ) : readings.length === 0 ? (
        <p className="text-gray-500 text-sm">
          No blood pressure data yet. Add a manual reading, or enable MortalLoom iCloud sync to share readings with the mobile app.
        </p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2a2a" />
              <XAxis
                dataKey="label"
                tick={{ fill: '#6b7280', fontSize: 11 }}
                interval={Math.max(0, Math.floor(chartData.length / 12))}
              />
              <YAxis
                tick={{ fill: '#6b7280', fontSize: 11 }}
                domain={[dataMin => Math.max(40, Math.floor(dataMin - 10)), dataMax => Math.ceil(dataMax + 10)]}
                label={{ value: 'mmHg', angle: -90, position: 'insideLeft', fill: '#6b7280', fontSize: 11 }}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <ReferenceLine y={120} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: 'Elevated', fill: '#f59e0b', fontSize: 10, position: 'right' }} />
              <ReferenceLine y={130} stroke="#f97316" strokeDasharray="3 3" label={{ value: 'Stage 1', fill: '#f97316', fontSize: 10, position: 'right' }} />
              <ReferenceLine y={140} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'Stage 2', fill: '#ef4444', fontSize: 10, position: 'right' }} />
              <Line type="monotone" dataKey="systolic" name="Systolic" stroke="#ef4444" dot={chartData.length <= 90} strokeWidth={2} connectNulls />
              <Line type="monotone" dataKey="diastolic" name="Diastolic" stroke="#3b82f6" dot={chartData.length <= 90} strokeWidth={2} connectNulls />
            </LineChart>
          </ResponsiveContainer>

          {latest && latestCategory && (
            <div className="mt-4 pt-4 border-t border-port-border">
              <div className="flex items-baseline justify-between flex-wrap gap-2">
                <div>
                  <span className="text-xs text-gray-500 uppercase tracking-wider">Latest</span>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-white font-mono">
                      {Math.round(latest.systolic)}/{Math.round(latest.diastolic)}
                    </span>
                    <span className="text-xs text-gray-500">mmHg · {latest.date}</span>
                  </div>
                </div>
                <span className={`text-sm font-semibold ${latestCategory.color}`}>
                  {latestCategory.label}
                </span>
              </div>
              <div className="flex items-center gap-1.5 mt-2 text-xs text-gray-400">
                {impact >= 0
                  ? <TrendingUp size={12} className="text-port-success" />
                  : <TrendingDown size={12} className="text-port-error" />}
                <span>
                  {impact >= 0 ? '+' : ''}{impact.toFixed(1)} years estimated life expectancy impact
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
