import { formatCount } from '../../utils/formatters';

export default function UsageActivityCharts({ activity, hourlyActivity, hourlyIncomplete }) {
  const maxActivity = Math.max(1, ...(activity?.map((day) => day.sessions) || []));
  const peakCount = Math.max(0, ...(hourlyActivity || []));
  const hourScaleMax = Math.max(1, peakCount);
  const peakHour = hourlyActivity?.indexOf(peakCount);
  const totalSessions = hourlyActivity?.reduce((sum, count) => sum + count, 0);
  const hourlySummary = peakCount > 0
    ? `Hourly distribution, ${formatCount(totalSessions)} sessions. Peak at ${peakHour}:00 with ${formatCount(peakCount)} sessions.`
    : 'Hourly distribution, 0 sessions.';
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
      {/* Selected-period activity */}
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3 sm:mb-4">Sessions in selected period</h3>
        <div className="flex items-end gap-1 sm:gap-2 h-32 sm:h-40">
          {activity?.map((day) => (
            <div key={day.date} title={`${day.date}: ${formatCount(day.sessions)} sessions`} className="flex-1 min-w-0 h-full flex flex-col items-center">
              {/* percent heights need a definite-height parent, so the bar sits in a flex-1 slot */}
              <div className="flex-1 w-full flex items-end min-h-0">
                <div
                  className="w-full bg-port-accent/60 rounded-t"
                  style={{ height: `${(day.sessions / maxActivity) * 100}%`, minHeight: day.sessions > 0 ? 4 : 0 }}
                />
              </div>
              {activity.length <= 12 && (
                <>
                  <div className="text-[10px] sm:text-xs text-gray-500 mt-1 sm:mt-2">{day.label}</div>
                  <div className="text-[10px] sm:text-xs text-gray-400">{formatCount(day.sessions)}</div>
                </>
              )}
            </div>
          ))}
          {activity?.length === 0 && <p className="text-sm text-gray-500">No sessions in this period.</p>}
        </div>
        {activity?.length > 12 && (
          <details className="mt-2 text-xs text-gray-400">
            <summary className="cursor-pointer">View session counts by date</summary>
            <ul className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-1">
              {activity.map((day) => <li key={day.date}>{day.date}: {formatCount(day.sessions)}</li>)}
            </ul>
          </details>
        )}
      </div>

      {/* Hourly Distribution */}
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3 sm:mb-4">Hourly Distribution</h3>
        {hourlyActivity ? <>
          <div className="flex items-end gap-0.5 h-24 sm:h-32" role="img" aria-label={hourlySummary}>
            {hourlyActivity.map((count, hour) => (
              <div key={hour} className="flex-1 h-full flex items-end" aria-hidden="true">
                <div
                  className="w-full bg-port-accent/40 rounded-t"
                  style={{ height: `${(count / hourScaleMax) * 100}%`, minHeight: count > 0 ? 2 : 0 }}
                  title={`${hour}:00 - ${count} sessions`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10px] sm:text-xs text-gray-500 mt-1 sm:mt-2">
            <span>12am</span>
            <span>6am</span>
            <span>12pm</span>
            <span>6pm</span>
            <span>12am</span>
          </div>
          <details className="mt-2 text-xs text-gray-400">
            <summary className="cursor-pointer py-2">View session counts by hour</summary>
            <ul className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-1">
              {hourlyActivity.map((count, hour) => <li key={hour}>{hour}:00: {formatCount(count)}</li>)}
            </ul>
          </details>
          <p className="text-xs text-gray-500 mt-1">Sessions in this period across available instances, by hour in your configured timezone (days recorded before this change are keyed and binned in UTC).</p>
          {hourlyIncomplete && <p className="text-xs text-port-warning mt-1">Partial: older sessions or unavailable instances do not provide hourly detail.</p>}
        </> : <p className="text-sm text-gray-500">Hourly data is unavailable for this period.</p>}
      </div>
    </div>
  );
}
