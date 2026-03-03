import { useState, useEffect } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { getPostSessions, getPostStats } from '../../../services/api';

const DRILL_LABELS = {
  'doubling-chain': 'Doubling Chain',
  'serial-subtraction': 'Serial Subtraction',
  'multiplication': 'Multiplication',
  'powers': 'Powers',
  'estimation': 'Estimation'
};

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 }
];

export default function PostHistory({ onBack }) {
  const [sessions, setSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [range, setRange] = useState(30);
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    loadData();
  }, [range]);

  async function loadData() {
    const from = range > 0
      ? new Date(Date.now() - range * 86400000).toISOString().split('T')[0]
      : undefined;
    const [s, st] = await Promise.all([
      getPostSessions(from).catch(() => []),
      getPostStats(range).catch(() => null)
    ]);
    setSessions((s || []).slice().reverse());
    setStats(st);
  }

  const chartData = sessions.slice().reverse().map(s => ({
    date: s.date,
    score: s.score
  }));

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">POST History</h2>
        </div>
        <div className="flex gap-1">
          {RANGES.map(r => (
            <button
              key={r.label}
              onClick={() => setRange(r.days)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                range === r.days
                  ? 'bg-port-accent/20 text-port-accent'
                  : 'text-gray-500 hover:text-white'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats Summary */}
      {stats && stats.sessionCount > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
            <div className="text-2xl font-mono font-bold text-white">{stats.sessionCount}</div>
            <div className="text-xs text-gray-500">Sessions</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
            <div className={`text-2xl font-mono font-bold ${
              stats.overall >= 80 ? 'text-port-success' :
              stats.overall >= 50 ? 'text-port-warning' : 'text-port-error'
            }`}>{stats.overall}</div>
            <div className="text-xs text-gray-500">Avg Score</div>
          </div>
          <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
            <div className="text-2xl font-mono font-bold text-white">
              {Object.keys(stats.byDrill || {}).length}
            </div>
            <div className="text-xs text-gray-500">Drill Types</div>
          </div>
        </div>
      )}

      {/* Chart */}
      {chartData.length > 1 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">Score Trend</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
              <CartesianGrid stroke="#2a2a2a" strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: '#666' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#666' }} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 8 }}
                labelStyle={{ color: '#999' }}
              />
              <Line type="monotone" dataKey="score" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Session List */}
      <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-port-border text-gray-500 text-left">
              <th className="px-4 py-2 font-medium w-8"></th>
              <th className="px-4 py-2 font-medium">Date</th>
              <th className="px-4 py-2 font-medium">Duration</th>
              <th className="px-4 py-2 font-medium">Modules</th>
              <th className="px-4 py-2 font-medium text-right">Score</th>
            </tr>
          </thead>
          <tbody>
            {sessions.flatMap(s => {
              const expanded = expandedId === s.id;
              const durationMin = Math.round((s.durationMs || 0) / 60000);
              const scoreColor = s.score >= 80 ? 'text-port-success' :
                s.score >= 50 ? 'text-port-warning' : 'text-port-error';

              const rows = [
                <tr
                  key={s.id}
                  onClick={() => setExpandedId(expanded ? null : s.id)}
                  className="border-b border-port-border/50 hover:bg-port-bg/50 cursor-pointer"
                >
                  <td className="px-4 py-2 text-gray-500">
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </td>
                  <td className="px-4 py-2 text-white">{s.date}</td>
                  <td className="px-4 py-2 text-gray-400">{durationMin}m</td>
                  <td className="px-4 py-2 text-gray-400">{(s.modules || []).join(', ')}</td>
                  <td className={`px-4 py-2 text-right font-mono font-medium ${scoreColor}`}>{s.score}</td>
                </tr>
              ];

              if (expanded) {
                for (const [i, task] of (s.tasks || []).entries()) {
                  const correct = task.questions?.filter(q => q.correct).length || 0;
                  const total = task.questions?.length || 0;
                  rows.push(
                    <tr key={`${s.id}-${i}`} className="bg-port-bg/30">
                      <td></td>
                      <td className="px-4 py-1.5 text-gray-500 text-xs" colSpan={2}>
                        {DRILL_LABELS[task.type] || task.type}
                      </td>
                      <td className="px-4 py-1.5 text-gray-500 text-xs">
                        {correct}/{total} correct
                      </td>
                      <td className="px-4 py-1.5 text-right text-gray-400 text-xs font-mono">
                        {task.score}
                      </td>
                    </tr>
                  );
                }
              }

              return rows;
            })}
          </tbody>
        </table>
        {sessions.length === 0 && (
          <div className="text-center text-gray-500 py-8">No sessions found for this range.</div>
        )}
      </div>
    </div>
  );
}
