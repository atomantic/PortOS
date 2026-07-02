import { Link } from 'react-router-dom';
import { HeartPulse, ArrowRight } from 'lucide-react';

// Health-logging habit loop. Reads the `meatspaceLogging` slice of
// dashboardState (cross-domain streak + this-week counts computed server-side)
// and deep-links into MeatSpace. Mirrors ActivityStreakWidget/DailyPostWidget's
// streak framing. Gated off until at least one health log exists.
export default function MeatSpaceStreakWidget({ dashboardState }) {
  const stats = dashboardState?.meatspaceLogging;
  if (!stats) return null;

  const streak = stats.currentStreak ?? 0;
  const longest = stats.longestStreak ?? 0;
  const streakGlyph = streak >= 7 ? '🔥' : streak >= 3 ? '⚡' : '✨';
  const activeDomains = (stats.domains || []).filter((d) => d.thisWeek > 0);

  return (
    <Link
      to="/meatspace/overview"
      className="bg-port-card border border-port-border rounded-xl p-4 h-full block hover:border-gray-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-3">
        <HeartPulse size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-white">Health Logging</h3>
        <span className="ml-auto flex items-center gap-1 text-xs text-port-accent">
          Open <ArrowRight size={12} />
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="text-2xl" aria-hidden="true">{streakGlyph}</div>
        <div>
          <div className="text-xl font-bold text-white">
            {streak} day{streak !== 1 ? 's' : ''}
          </div>
          <div className="text-xs text-gray-500">
            {streak > 0 ? 'Logging streak' : 'No streak — log something today'}
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

      {/* 7-day sparkline: intensity by number of domains logged that day. */}
      <div className="flex gap-1 mt-3">
        {(stats.last7Days || []).map((day) => (
          <div
            key={day.date}
            className={`flex-1 h-2 rounded-full ${day.logged ? 'bg-port-success' : 'bg-port-border'}`}
            title={`${day.label}: ${day.domains} domain${day.domains !== 1 ? 's' : ''} logged`}
          />
        ))}
      </div>

      <div className="mt-3 text-xs text-gray-400">
        {activeDomains.length > 0 ? (
          <span>
            This week:{' '}
            {activeDomains.map((d, i) => (
              <span key={d.key}>
                {i > 0 && ', '}
                <span className="text-gray-300">{d.label}</span> {d.thisWeek}
              </span>
            ))}
          </span>
        ) : (
          <span>No logs this week yet</span>
        )}
      </div>
    </Link>
  );
}
