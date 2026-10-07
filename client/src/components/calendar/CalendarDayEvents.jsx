import { useEffect } from 'react';
import Drawer from '../Drawer';
import CalendarWindowStatus from './CalendarWindowStatus';
import { eventChipStyle, eventOccursOnDay } from './calendarUtils';
import { formatCount, formatDateFull, formatTimeOfDay } from '../../utils/formatters';

// One selection path for sparse month cells and tightly packed time grids.
// Details replace this drawer while the URL retains the day and view context.
export default function CalendarDayEvents({
  date, windowEvents, colorMap, themeMode, selectedEvent, triggerRef, onEvent, onClose,
}) {
  const { events, loading, complete } = windowEvents;
  const dayEvents = date ? events.filter(event => eventOccursOnDay(event, date))
    .sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || new Date(a.startTime) - new Date(b.startTime)) : [];

  useEffect(() => {
    if (!date && !selectedEvent && triggerRef.current) {
      triggerRef.current.focus({ preventScroll: true });
      triggerRef.current = null;
    }
  }, [date, selectedEvent, triggerRef]);

  return (
    <Drawer
      open={!!date && !selectedEvent && (events.length > 0 || !loading)}
      onClose={onClose}
      title={date ? formatDateFull(date) : ''}
      subtitle={`${formatCount(dayEvents.length)} ${dayEvents.length === 1 ? 'event' : 'events'}${complete ? '' : ' loaded'}`}
      closeLabel="Close day events"
    >
      <div className="space-y-2">
        <CalendarWindowStatus {...windowEvents} />
        {complete && dayEvents.length === 0 && <p className="text-sm text-gray-400">No events available for this date.</p>}
        {dayEvents.map(event => (
          <button
            key={`${event.accountId}:${event.id}`}
            type="button"
            onClick={() => onEvent(event)}
            className="w-full min-h-[44px] text-left px-3 py-2 rounded transition-colors hover:brightness-125"
            style={eventChipStyle(colorMap.get(event.subcalendarId) || null, themeMode)}
          >
            <span className="block text-xs">{event.isAllDay ? 'All day'
              : `${new Date(event.startTime).toDateString() === date.toDateString()
                ? formatTimeOfDay(event.startTime) : 'Continues'} – ${formatTimeOfDay(event.endTime)}`}</span>
            <span className="block text-sm break-words">{event.title}</span>
          </button>
        ))}
      </div>
    </Drawer>
  );
}
