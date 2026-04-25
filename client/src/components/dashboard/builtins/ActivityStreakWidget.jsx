export default function ActivityStreakWidget({ dashboardState }) {
  const { usage } = dashboardState;
  if (!usage) return null;
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="text-2xl" aria-hidden="true">
          {usage.currentStreak >= 7 ? '🔥' : usage.currentStreak >= 3 ? '⚡' : '✨'}
        </div>
        <div>
          <div className="text-xl font-bold text-white">
            {usage.currentStreak} day{usage.currentStreak !== 1 ? 's' : ''}
          </div>
          <div className="text-xs text-gray-500">Current streak</div>
        </div>
        {usage.longestStreak > usage.currentStreak && (
          <div className="ml-auto text-right">
            <div className="text-sm font-semibold text-port-accent">{usage.longestStreak} days</div>
            <div className="text-xs text-gray-500">Best</div>
          </div>
        )}
        {usage.currentStreak === usage.longestStreak && usage.currentStreak > 0 && (
          <div className="ml-auto px-2 py-1 bg-port-success/20 text-port-success text-xs rounded-full">
            Personal best!
          </div>
        )}
      </div>
      <div className="flex gap-1">
        {usage.last7Days?.map((day) => (
          <div
            key={day.date}
            className={`flex-1 h-2 rounded-full ${day.sessions > 0 ? 'bg-port-success' : 'bg-port-border'}`}
            title={`${day.label}: ${day.sessions} sessions`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-gray-500">
        <span>7d ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}
