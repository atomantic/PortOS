import { Link } from 'react-router';
import { CalendarDays, ArrowRight } from 'lucide-react';
import { useTimeTick } from '../../../hooks/useTimeTick';
import { formatTimeOfDay } from '../../../utils/formatters';

// Glanceable "what's left today" agenda. Reads the shared `calendarAgenda`
// slice of dashboardState (populated from GET /api/calendar/agenda — the
// server owns the timezone-correct day window, so this never re-derives it)
// and deep-links into Calendar → Agenda. Gated off until the user has a
// calendar account connected.
export default function TodayAgendaWidget({ dashboardState }) {
  // Minute tick keeps the past-event dimming and remaining count honest as
  // the day advances between dashboard data refreshes.
  const now = useTimeTick(60000);
  const agenda = dashboardState?.calendarAgenda;
  if (!agenda) return null;

  const events = Array.isArray(agenda.events) ? agenda.events : [];
  // An event is "done" once it has ended (all-day events never dim).
  const rows = events.map((event) => {
    const end = new Date(event.endTime || event.startTime).getTime();
    return { event, past: !event.isAllDay && Number.isFinite(end) && end < now };
  });
  const nextEvent = rows.find((r) => !r.event.isAllDay && !r.past)?.event;
  const remaining = rows.filter((r) => !r.past).length;
  const total = agenda.total ?? events.length;

  return (
    <Link
      to="/calendar/agenda"
      className="bg-port-card border border-port-border rounded-xl p-4 h-full block hover:border-gray-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-3">
        <CalendarDays size={16} className="text-gray-500" />
        <h3 className="text-sm font-semibold text-white">Today&apos;s Agenda</h3>
        <span className="ml-auto flex items-center gap-1 text-xs text-port-accent">
          Open <ArrowRight size={12} />
        </span>
      </div>

      {events.length === 0 ? (
        <div className="text-xs text-gray-500">Nothing on the calendar today 🎉</div>
      ) : (
        <>
          <div className="text-xs text-gray-500 mb-2">
            {remaining} of {total} event{total !== 1 ? 's' : ''} remaining
          </div>
          <ul className="space-y-1">
            {rows.map(({ event, past }) => (
              <li
                key={`${event.accountId}:${event.id}`}
                className={`flex items-center gap-2 text-xs ${past ? 'opacity-50' : ''}`}
              >
                <span
                  className={`shrink-0 w-16 tabular-nums ${event === nextEvent ? 'text-port-accent font-semibold' : 'text-gray-500'}`}
                >
                  {event.isAllDay ? 'All day' : formatTimeOfDay(event.startTime) || 'TBD'}
                </span>
                <span
                  className={`flex-1 truncate ${past ? 'line-through text-gray-500' : 'text-gray-300'}`}
                  title={event.location ? `${event.title} — ${event.location}` : event.title}
                >
                  {event.title}
                </span>
              </li>
            ))}
          </ul>
          {total > events.length && (
            <div className="text-xs text-gray-500 mt-2">+{total - events.length} more</div>
          )}
        </>
      )}
    </Link>
  );
}
