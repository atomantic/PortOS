export default function HourlyActivityWidget({ dashboardState }) {
  const hourlyActivity = dashboardState.usage?.hourlyActivity;
  if (!hourlyActivity) return null;

  const maxActivity = Math.max(...hourlyActivity, 1);
  const peakValue = Math.max(...hourlyActivity);
  const peakHours = hourlyActivity
    .map((val, idx) => ({ hour: idx, count: val }))
    .filter((h) => h.count === peakValue && h.count > 0);
  const totalSessions = hourlyActivity.reduce((sum, val) => sum + val, 0);

  const formatHour = (hour) => {
    if (hour === 0) return '12a';
    if (hour === 12) return '12p';
    return hour < 12 ? `${hour}a` : `${hour - 12}p`;
  };

  const getIntensityClass = (count) => {
    if (count === 0) return 'bg-port-border/30';
    const intensity = count / maxActivity;
    if (intensity >= 0.8) return 'bg-port-success';
    if (intensity >= 0.5) return 'bg-port-success/70';
    if (intensity >= 0.25) return 'bg-port-success/40';
    return 'bg-port-success/20';
  };

  const peakDescription = peakHours.length === 0 || peakValue === 0
    ? null
    : peakHours.length === 1
      ? `Peak: ${formatHour(peakHours[0].hour)} (${peakValue} sessions)`
      : `Peak hours: ${peakHours.slice(0, 3).map((h) => formatHour(h.hour)).join(', ')} (${peakValue} sessions each)`;

  if (totalSessions === 0) return null;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <div className="text-2xl" aria-hidden="true">⏰</div>
          <div>
            <h3 className="text-lg font-semibold text-white">Activity by Hour</h3>
            <p className="text-sm text-gray-500">{totalSessions} total sessions tracked</p>
          </div>
        </div>
        {peakDescription && <div className="text-sm text-port-success">{peakDescription}</div>}
      </div>

      <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5 sm:gap-1" role="img" aria-label="Hourly activity heatmap">
        {hourlyActivity.map((count, hour) => (
          <div
            key={hour}
            className={`aspect-square rounded-xs ${getIntensityClass(count)} transition-colors cursor-default min-w-[20px] min-h-[20px]`}
            title={`${formatHour(hour)}: ${count} session${count !== 1 ? 's' : ''}`}
            aria-label={`${formatHour(hour)}: ${count} sessions`}
          />
        ))}
      </div>

      <div className="mt-2 grid grid-cols-6 sm:grid-cols-12 gap-1.5 sm:gap-1 text-xs text-gray-500">
        {hourlyActivity.map((_, hour) => (
          <div key={hour} className="text-center">
            <span className="hidden sm:inline">{hour % 3 === 0 ? formatHour(hour) : ''}</span>
            <span className="sm:hidden">{hour % 4 === 0 ? formatHour(hour) : ''}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 text-xs text-gray-500">
        <span>Less</span>
        <div className="flex gap-1">
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-xs bg-port-border/30" />
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-xs bg-port-success/20" />
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-xs bg-port-success/40" />
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-xs bg-port-success/70" />
          <div className="w-4 h-4 sm:w-3 sm:h-3 rounded-xs bg-port-success" />
        </div>
        <span>More</span>
      </div>
    </div>
  );
}
