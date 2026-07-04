import { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeft, Flame, Trophy, Clock, Gauge } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import { getPostProgress } from '../../../services/api';
import useChartColors from '../../../hooks/useChartColors.js';
import { formatDurationMin } from '../../../utils/formatters';
import { DRILL_TO_DOMAIN, domainLabel } from './constants';
import { streakGlyph } from '../../../lib/streakGlyph.js';
import PostHistory from './PostHistory';

const RANGES = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 }
];

// Same domain palette PostHistory uses so the two views read as one system.
const DOMAIN_HEX = {
  math: '#60a5fa',
  memory: '#4ade80',
  wordplay: '#c084fc',
  verbal: '#fbbf24',
  imagination: '#22d3ee',
  cognitive: '#fb7185'
};
const domainHex = (key) => DOMAIN_HEX[key] || '#a3a3a3';

const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);

// Build per-DOMAIN per-day series client-side from the server's per-DRILL
// series (keyed by drill type), mapping each type to its domain via
// DRILL_TO_DOMAIN — the same type→domain resolution PostHistory uses, which is
// finer-grained than the server's coarse module buckets.
function buildDomainSeries(byDrill) {
  const domains = {}; // domainKey -> Map(date -> {scores, accs, resp})
  for (const [type, points] of Object.entries(byDrill || {})) {
    const domain = DRILL_TO_DOMAIN[type] || 'other';
    const dmap = domains[domain] || (domains[domain] = new Map());
    for (const p of points || []) {
      const b = dmap.get(p.date) || { scores: [], accs: [], resp: [] };
      if (typeof p.score === 'number') b.scores.push(p.score);
      if (p.accuracy != null) b.accs.push(p.accuracy);
      if (p.avgResponseMs != null) b.resp.push(p.avgResponseMs);
      dmap.set(p.date, b);
    }
  }
  const out = {};
  for (const [domain, dmap] of Object.entries(domains)) {
    out[domain] = Array.from(dmap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, b]) => ({
        date,
        score: b.scores.length ? Math.round(mean(b.scores)) : null,
        accuracy: b.accs.length ? mean(b.accs) : null,
        avgResponseMs: b.resp.length ? Math.round(mean(b.resp)) : null,
      }));
  }
  return out;
}

export default function PostProgress({ subtab, onBack }) {
  const navigate = useNavigate();
  const chartColors = useChartColors();
  const [progress, setProgress] = useState(null);
  const [range, setRange] = useState(90);
  const [domain, setDomain] = useState('all');
  const [loaded, setLoaded] = useState(false);

  const loadData = useCallback(async () => {
    // The Sessions sub-view renders PostHistory (its own fetch) — no need to
    // pull the progress payload for it.
    if (subtab === 'sessions') return;
    const p = await getPostProgress(range, { silent: true })
      .catch((err) => { console.warn('⚠️ Failed to load POST progress: ' + err.message); return null; });
    setProgress(p);
    setLoaded(true);
  }, [range, subtab]);

  useEffect(() => { loadData(); }, [loadData]);

  const domainSeries = useMemo(
    () => buildDomainSeries(progress?.series?.byDrill),
    [progress]
  );
  const domainKeys = useMemo(() => Object.keys(domainSeries).sort(), [domainSeries]);

  // The active series drives all three trend charts: overall per-day buckets, or
  // one domain's per-day series when a domain is selected.
  const activeSeries = useMemo(() => {
    if (domain !== 'all' && domainSeries[domain]) return domainSeries[domain];
    return progress?.series?.byDay || [];
  }, [domain, domainSeries, progress]);

  const scoreData = useMemo(
    () => activeSeries.filter(p => p.score != null).map(p => ({ date: p.date, score: p.score })),
    [activeSeries]
  );
  const accuracyData = useMemo(
    () => activeSeries.filter(p => p.accuracy != null).map(p => ({ date: p.date, accuracy: Math.round(p.accuracy * 100) })),
    [activeSeries]
  );
  const speedData = useMemo(
    () => activeSeries.filter(p => p.avgResponseMs != null).map(p => ({ date: p.date, seconds: +(p.avgResponseMs / 1000).toFixed(2) })),
    [activeSeries]
  );
  const minutesData = useMemo(
    () => (progress?.series?.byDay || []).map(p => ({ date: p.date, minutes: p.minutes })),
    [progress]
  );

  // Sub-view: the full session-list table (reuses PostHistory), deep-linked at
  // /post/progress/sessions.
  if (subtab === 'sessions') {
    return (
      <div className="space-y-4">
        <ProgressTabs subtab="sessions" navigate={navigate} />
        <PostHistory onBack={onBack} />
      </div>
    );
  }

  const streak = progress?.streak || { current: 0, longest: 0 };
  const totals = progress?.totals || { minutesTrained: 0, sessions: 0, practiceEntries: 0 };
  const mastery = progress?.mastery || { multiplication: null, memoryItems: [] };
  const dueTotal = (mastery.memoryItems || []).reduce((n, m) => n + (m.dueCount || 0), 0);
  const hasAny = totals.sessions > 0 || totals.practiceEntries > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors" aria-label="Back">
            <ArrowLeft size={20} />
          </button>
          <h2 className="text-xl font-bold text-white">Progress</h2>
        </div>
        <div className="flex gap-1">
          {RANGES.map(r => (
            <button
              key={r.label}
              onClick={() => setRange(r.days)}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                range === r.days ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-white'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <ProgressTabs subtab={undefined} navigate={navigate} />

      {loaded && !hasAny && (
        <div className="bg-port-card border border-port-border rounded-lg text-center text-gray-500 py-12 text-sm">
          No training activity yet. Complete a POST session or a practice drill to start tracking your progress.
        </div>
      )}

      {hasAny && (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 sm:gap-4">
            <StatCard
              label="Current Streak"
              value={streak.current}
              suffix={streak.current === 1 ? 'day' : 'days'}
              icon={<span aria-hidden="true">{streakGlyph(streak.current)}</span>}
            />
            <StatCard
              label="Longest Streak"
              value={streak.longest}
              suffix={streak.longest === 1 ? 'day' : 'days'}
              icon={<Trophy size={14} className="text-port-accent" />}
            />
            <StatCard
              label="Time in Training"
              value={formatDurationMin(totals.minutesTrained) || '0m'}
              icon={<Clock size={14} className="text-port-success" />}
            />
            <StatCard label="Sessions" value={totals.sessions} />
            <StatCard label="Practice Drills" value={totals.practiceEntries} />
          </div>

          {/* Domain selector */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500 flex items-center gap-1"><Gauge size={12} /> Trend focus:</span>
            <button
              onClick={() => setDomain('all')}
              className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                domain === 'all' ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-white'
              }`}
            >
              All domains
            </button>
            {domainKeys.map(key => (
              <button
                key={key}
                onClick={() => setDomain(key)}
                className={`px-3 py-1 text-xs rounded-lg transition-colors flex items-center gap-1.5 ${
                  domain === key ? 'bg-port-accent/20 text-port-accent' : 'text-gray-500 hover:text-white'
                }`}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: domainHex(key) }} />
                {domainLabel(key)}
              </button>
            ))}
          </div>

          {/* Trend charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
            <TrendChart
              title="Score Trend"
              data={scoreData}
              dataKey="score"
              domainRange={[0, 100]}
              stroke={domain === 'all' ? chartColors.accent : domainHex(domain)}
              chartColors={chartColors}
              emptyText="Complete more sessions to chart your score."
            />
            <TrendChart
              title="Accuracy Trend"
              data={accuracyData}
              dataKey="accuracy"
              domainRange={[0, 100]}
              unit="%"
              stroke={chartColors.success}
              chartColors={chartColors}
              emptyText="No accuracy data yet."
            />
            <TrendChart
              title="Response Time (getting faster)"
              data={speedData}
              dataKey="seconds"
              domainRange={[0, 'auto']}
              unit="s"
              stroke={chartColors.warning}
              chartColors={chartColors}
              emptyText="No response-time data yet."
            />
            <TrendChart
              title="Time in Training (min/day)"
              data={minutesData}
              dataKey="minutes"
              domainRange={[0, 'auto']}
              unit="m"
              stroke={chartColors.chart2 || chartColors.success}
              chartColors={chartColors}
              emptyText="No training time logged yet."
            />
          </div>

          {/* Mastery panel */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">
            {mastery.multiplication && (
              <div className="bg-port-card border border-port-border rounded-lg p-4">
                <h3 className="text-sm font-medium text-gray-400 mb-3">Multiplication Ladder</h3>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-mono font-bold text-white">L{mastery.multiplication.level}</span>
                  <span className="text-sm text-gray-400">{mastery.multiplication.description}</span>
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Earned floor: L{mastery.multiplication.floorLevel}
                </div>
              </div>
            )}

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-400">Memory Mastery</h3>
                {dueTotal > 0 && (
                  <span className="px-2 py-0.5 bg-port-warning/20 text-port-warning text-xs rounded-full">
                    {dueTotal} due
                  </span>
                )}
              </div>
              {(mastery.memoryItems || []).length > 0 ? (
                <div className="space-y-2">
                  {mastery.memoryItems.map(item => (
                    <div key={item.id} className="flex items-center gap-3">
                      <span className="text-xs text-gray-400 w-32 shrink-0 truncate" title={item.title}>{item.title}</span>
                      <div className="flex-1 h-2 bg-port-bg rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-port-success"
                          style={{ width: `${Math.min(100, Math.max(0, item.overallPct))}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono w-10 text-right text-gray-400">{Math.round(item.overallPct)}%</span>
                      {item.dueCount > 0 && <Flame size={12} className="text-port-warning shrink-0" aria-label="Due for review" />}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center text-gray-500 py-6 text-sm">No memory items yet.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ProgressTabs({ subtab, navigate }) {
  const tabs = [
    { id: undefined, label: 'Trends', to: '/post/progress' },
    { id: 'sessions', label: 'Sessions', to: '/post/progress/sessions' },
  ];
  return (
    <div className="flex gap-1 border-b border-port-border">
      {tabs.map(t => (
        <button
          key={t.label}
          onClick={() => navigate(t.to)}
          className={`px-4 py-2 text-sm transition-colors border-b-2 -mb-px ${
            subtab === t.id
              ? 'border-port-accent text-white'
              : 'border-transparent text-gray-500 hover:text-white'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function TrendChart({ title, data, dataKey, domainRange, unit, stroke, chartColors, emptyText }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-3">{title}</h3>
      {data.length > 1 ? (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid stroke={chartColors.grid} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: chartColors.axis }} />
            <YAxis
              domain={domainRange}
              tick={{ fontSize: 11, fill: chartColors.axis }}
              tickFormatter={unit ? (v) => `${v}${unit}` : undefined}
            />
            <Tooltip
              contentStyle={{ backgroundColor: chartColors.tooltipBg, border: `1px solid ${chartColors.tooltipBorder}`, borderRadius: 8 }}
              labelStyle={{ color: chartColors.axis }}
              formatter={(v) => [`${v}${unit || ''}`, title]}
            />
            <Line type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={2} dot={{ r: 3 }} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="text-center text-gray-500 py-12 text-sm">{emptyText}</div>
      )}
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
