import { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, Flame, Trophy } from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';
import { getPostSessions, getPostStats } from '../../../services/api';
import useChartColors from '../../../hooks/useChartColors.js';
import { LLM_DRILL_TYPES, DRILL_LABELS, DOMAINS, DRILL_TO_DOMAIN } from './constants';

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 }
];

// Concrete hex per domain so recharts SVG fills follow the same palette as the
// `text-*-400` domain classes in constants.js (SVG can't read CSS custom props).
const DOMAIN_HEX = {
  math: '#60a5fa',       // blue-400
  memory: '#4ade80',     // green-400
  wordplay: '#c084fc',   // purple-400
  verbal: '#fbbf24',     // amber-400
  imagination: '#22d3ee' // cyan-400
};

const domainLabel = (key) => (key === 'other' ? 'Other' : DOMAINS[key]?.label || key);
const domainHex = (key) => DOMAIN_HEX[key] || '#a3a3a3';

const scoreColorClass = (score) =>
  score >= 80 ? 'text-port-success' : score >= 50 ? 'text-port-warning' : 'text-port-error';

export default function PostHistory({ onBack }) {
  const chartColors = useChartColors();
  const [sessions, setSessions] = useState([]);
  const [stats, setStats] = useState(null);
  const [range, setRange] = useState(30);
  const [expandedId, setExpandedId] = useState(null);

  const loadData = useCallback(async () => {
    const from = range > 0
      ? new Date(Date.now() - range * 86400000).toISOString().split('T')[0]
      : undefined;
    const [s, st] = await Promise.all([
      getPostSessions(from).catch(err => { console.warn('⚠️ Failed to load POST sessions: ' + err.message); return []; }),
      getPostStats(range).catch(err => { console.warn('⚠️ Failed to load POST stats: ' + err.message); return null; })
    ]);
    setSessions((s || []).slice().reverse());
    setStats(st);
  }, [range]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const chartData = useMemo(
    () => sessions.slice().reverse().map(s => ({ date: s.date, score: s.score })),
    [sessions]
  );

  // Per-domain averages + per-drill breakdown, both derived from `byDrill`.
  // getPostStats keys byDrill as `${task.module}:${task.type}`, where task.module
  // is a COARSE module the runners save (`mental-math`, `llm-drills`, `memory`) —
  // NOT a DOMAINS key. So the real domain must come from the drill TYPE via
  // DRILL_TO_DOMAIN, not from the module segment (`byModule` is likewise coarse
  // and can't be labeled/colored as a domain). The per-domain score is the mean
  // of that domain's per-drill averages.
  const { domainData, drillsByDomain } = useMemo(() => {
    const byDrill = stats?.byDrill || {};
    const groups = {}; // domainKey -> [{ type, label, score }]
    for (const [key, score] of Object.entries(byDrill)) {
      const type = key.slice(key.indexOf(':') + 1);
      const domain = DRILL_TO_DOMAIN[type] || 'other';
      if (!groups[domain]) groups[domain] = [];
      groups[domain].push({ type, label: DRILL_LABELS[type] || type, score });
    }
    const domainList = Object.entries(groups)
      .map(([key, drills]) => ({
        key,
        label: domainLabel(key),
        score: Math.round(drills.reduce((a, d) => a + d.score, 0) / drills.length),
        drills: drills.slice().sort((a, b) => b.score - a.score)
      }))
      .sort((a, b) => b.score - a.score);
    return {
      domainData: domainList.map(({ key, label, score }) => ({ key, label, score })),
      drillsByDomain: domainList.map(({ key, label, drills }) => ({ key, label, drills }))
    };
  }, [stats]);

  const hasStats = stats && stats.sessionCount > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors" aria-label="Back">
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

      {/* Stat summary cards */}
      {hasStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <StatCard label="Sessions" value={stats.sessionCount} />
          <StatCard label="Avg Score" value={stats.overall} valueClass={scoreColorClass(stats.overall)} />
          <StatCard
            label="Current Streak"
            value={stats.currentStreak}
            suffix={stats.currentStreak === 1 ? 'day' : 'days'}
            icon={<Flame size={14} className="text-port-warning" />}
          />
          <StatCard
            label="Longest Streak"
            value={stats.longestStreak}
            suffix={stats.longestStreak === 1 ? 'day' : 'days'}
            icon={<Trophy size={14} className="text-port-accent" />}
          />
        </div>
      )}

      {/* Analytics grid: score trend (wide) + per-domain averages */}
      {hasStats && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6">
          <div className="bg-port-card border border-port-border rounded-lg p-4 xl:col-span-2">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Score Trend</h3>
            {chartData.length > 1 ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={chartData}>
                  <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: chartColors.axis }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: chartColors.axis }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, borderRadius: 8 }}
                    labelStyle={{ color: chartColors.axis }}
                  />
                  <Line type="monotone" dataKey="score" stroke={chartColors.accent} strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center text-gray-500 py-12 text-sm">
                Complete more sessions to chart your trend.
              </div>
            )}
          </div>

          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Avg by Domain</h3>
            {domainData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={domainData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: chartColors.axis }} />
                  <YAxis
                    type="category"
                    dataKey="label"
                    width={80}
                    tick={{ fontSize: 11, fill: chartColors.axis }}
                  />
                  <Tooltip
                    cursor={{ fill: chartColors.grid, opacity: 0.2 }}
                    contentStyle={{ backgroundColor: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, borderRadius: 8 }}
                    labelStyle={{ color: chartColors.axis }}
                  />
                  <Bar dataKey="score" radius={[0, 4, 4, 0]}>
                    {domainData.map(d => (
                      <Cell key={d.key} fill={domainHex(d.key)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center text-gray-500 py-12 text-sm">No domain data yet.</div>
            )}
          </div>
        </div>
      )}

      {/* Per-drill breakdown grouped by domain */}
      {hasStats && drillsByDomain.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-4">Drill Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            {drillsByDomain.map(domain => (
              <div key={domain.key}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: domainHex(domain.key) }} />
                  <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{domain.label}</span>
                </div>
                <div className="space-y-2">
                  {domain.drills.map(drill => (
                    <div key={drill.type} className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-32 shrink-0 truncate" title={drill.label}>{drill.label}</span>
                      <div className="flex-1 h-2 bg-port-bg rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.min(100, Math.max(0, drill.score))}%`, backgroundColor: domainHex(domain.key) }}
                        />
                      </div>
                      <span className={`text-xs font-mono w-8 text-right ${scoreColorClass(drill.score)}`}>{drill.score}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Session List */}
      <div className="bg-port-card border border-port-border rounded-lg overflow-hidden overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
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
                  <td className={`px-4 py-2 text-right font-mono font-medium ${scoreColorClass(s.score)}`}>{s.score}</td>
                </tr>
              ];

              if (expanded) {
                for (const [i, task] of (s.tasks || []).entries()) {
                  const isLlm = LLM_DRILL_TYPES.includes(task.type);
                  const detail = isLlm
                    ? `${task.responses?.length || 0} responses`
                    : `${task.questions?.filter(q => q.correct).length || 0}/${task.questions?.length || 0} correct`;
                  rows.push(
                    <tr key={`${s.id}-${i}`} className="bg-port-bg/30">
                      <td></td>
                      <td className="px-4 py-1.5 text-gray-500 text-xs" colSpan={2}>
                        {DRILL_LABELS[task.type] || task.type}
                      </td>
                      <td className="px-4 py-1.5 text-gray-500 text-xs">
                        {detail}
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

function StatCard({ label, value, suffix, valueClass = 'text-white', icon }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3 text-center">
      <div className={`text-2xl font-mono font-bold flex items-center justify-center gap-1.5 ${valueClass}`}>
        {icon}
        {value}
        {suffix && <span className="text-xs font-normal text-gray-500 self-end mb-1">{suffix}</span>}
      </div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}
