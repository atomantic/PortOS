import { CalendarDays, Unlink } from 'lucide-react';

export default function GoalLinkedCalendars({
  goal, subcalendars, selectedCalendar, setSelectedCalendar,
  calendarMatchPattern, setCalendarMatchPattern, handleLinkCalendar, handleUnlinkCalendar
}) {
  return (
    <div>
      <div className="flex items-center gap-1 mb-2">
        <CalendarDays className="w-3.5 h-3.5 text-gray-500" />
        <span className="text-xs font-medium text-gray-400">
          Calendars ({goal.linkedCalendars?.length || 0})
        </span>
      </div>
      {goal.linkedCalendars?.length > 0 && (
        <div className="space-y-1 mb-2">
          {goal.linkedCalendars.map(lc => (
            <div key={lc.subcalendarId} className="flex items-center gap-2 text-xs">
              <span className="text-gray-300 flex-1 truncate">{lc.subcalendarName}</span>
              {lc.matchPattern && (
                <span className="text-gray-600 truncate max-w-[80px]" title={`Pattern: ${lc.matchPattern}`}>
                  /{lc.matchPattern}/
                </span>
              )}
              <button
                onClick={() => handleUnlinkCalendar(lc.subcalendarId)}
                className="p-0.5 text-gray-600 hover:text-red-400"
                title="Unlink"
              >
                <Unlink className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {subcalendars.length > 0 && (
        <div className="space-y-1">
          <div className="flex gap-1">
            <select
              value={selectedCalendar}
              onChange={e => setSelectedCalendar(e.target.value)}
              className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
            >
              <option value="">Link calendar...</option>
              {subcalendars
                .filter(sc => !goal.linkedCalendars?.some(lc => lc.subcalendarId === sc.calendarId))
                .map(sc => <option key={sc.calendarId} value={sc.calendarId}>{sc.name}</option>)}
            </select>
            <button
              onClick={handleLinkCalendar}
              disabled={!selectedCalendar}
              className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent disabled:opacity-50"
            >
              Link
            </button>
          </div>
          {selectedCalendar && (
            <input
              type="text"
              value={calendarMatchPattern}
              onChange={e => setCalendarMatchPattern(e.target.value)}
              placeholder="Match pattern (optional)"
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white"
            />
          )}
        </div>
      )}
    </div>
  );
}
