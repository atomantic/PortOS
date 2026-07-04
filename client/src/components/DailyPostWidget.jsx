import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Brain, ArrowRight } from 'lucide-react';
import * as api from '../services/api';
import { streakGlyph } from '../lib/streakGlyph.js';

// Surfaces the daily POST cognitive self-test on the dashboard: today's
// completion status, the current practice streak, and a one-click way into the
// launcher. Self-fetches its stats (the dashboardState payload doesn't carry
// POST data), mirroring DeathClockWidget.
export default function DailyPostWidget() {
  const [stats, setStats] = useState(null);
  const [loaded, setLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    const data = await api.getPostStats().catch(() => null);
    setStats(data);
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
    </Link>
  );
}
