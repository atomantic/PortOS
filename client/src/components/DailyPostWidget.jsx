import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Brain, ArrowRight, Compass } from 'lucide-react';
import * as api from '../services/api';
import { streakGlyph } from '../lib/streakGlyph.js';
import { computeGoalProgress } from './meatspace/post/constants';

// Surfaces the daily POST cognitive self-test on the dashboard: today's
// completion status, the current practice streak, the top "what to practice
// next" recommendation, and goal progress — plus a one-click way into the
// launcher. Self-fetches (the dashboardState payload doesn't carry POST data),
// mirroring DeathClockWidget.
export default function DailyPostWidget() {
  const [stats, setStats] = useState(null);
  const [statsWeek, setStatsWeek] = useState(null);
  const [config, setConfig] = useState(null);
  const [topRec, setTopRec] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    // Recommendations/config/week-stats are best-effort — a failure just hides
    // the extra rows; the streak card still renders from `stats`.
    const [data, week, cfg, recs] = await Promise.all([
      api.getPostStats().catch(() => null),
      api.getPostStats(7).catch(() => null),
      api.getPostConfig().catch(() => null),
      api.getPostRecommendations(1).catch(() => null),
    ]);
    setStats(data);
    setStatsWeek(week);
    setConfig(cfg);
    setTopRec(recs?.recommendations?.[0] || null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (!loaded) return null;

  const streak = stats?.currentStreak ?? 0;
  const longest = stats?.longestStreak ?? 0;
  const completedToday = !!stats?.completedToday;
  const todayScore = stats?.todayScore;

  // Widget goal metrics: streak + this week's sessions (no today-minutes /
  // Morse-WPM fetch here — computeGoalProgress omits goals whose metric is
  // unavailable, so those simply don't render on the compact widget).
  const goalRows = computeGoalProgress(config?.goals, {
    currentStreak: streak,
    weekSessions: statsWeek?.sessionCount ?? 0,
  }).slice(0, 2);

  return (
    <Link
      to="/post/launcher"
      className="bg-port-card border border-port-border rounded-xl p-4 h-full block hover:border-gray-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-3">
        <Brain size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-white">Daily POST</h3>
        {completedToday ? (
          <span className="ml-auto px-2 py-0.5 bg-port-success/20 text-port-success text-xs rounded-full">
            Done today{typeof todayScore === 'number' ? ` · ${todayScore}%` : ''}
          </span>
        ) : (
          <span className="ml-auto flex items-center gap-1 text-xs text-port-accent">
            Start <ArrowRight size={12} />
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="text-2xl" aria-hidden="true">{streakGlyph(streak)}</div>
        <div>
          <div className="text-xl font-bold text-white">
            {streak} day{streak !== 1 ? 's' : ''}
          </div>
          <div className="text-xs text-gray-500">
            {streak > 0 ? 'Current streak' : 'No streak — start one today'}
          </div>
        </div>
        {longest > streak && (
          <div className="ml-auto text-right">
            <div className="text-sm font-semibold text-port-accent">{longest} days</div>
            <div className="text-xs text-gray-500">Best</div>
          </div>
        )}
        {streak > 0 && streak === longest && (
          <div className="ml-auto px-2 py-1 bg-port-success/20 text-port-success text-xs rounded-full">
            Personal best!
          </div>
        )}
      </div>

      {/* Top "what to practice next" recommendation (issue #2100). */}
      {topRec && (
        <div className="mt-3 flex items-start gap-2 pt-3 border-t border-port-border">
          <Compass size={14} className="text-port-accent mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-xs font-medium text-gray-400">Up next</div>
            <div className="text-sm text-white truncate">{topRec.title}</div>
          </div>
        </div>
      )}

      {/* Goal progress chips (issue #2100) — only goals with a known metric. */}
      {goalRows.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {goalRows.map(g => (
            <span key={g.key} className={g.met ? 'text-port-success' : 'text-gray-400'}>
              {g.label}: <span className="font-mono">{g.current}/{g.target}</span>
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
