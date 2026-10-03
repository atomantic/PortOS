import { useMemo, useRef } from 'react';
import {CalendarDays, ChevronLeft, ChevronRight} from 'lucide-react';
import { useCalendarWindowEvents } from '../../hooks/useCalendarWindowEvents';
import CalendarWindowStatus from './CalendarWindowStatus';
import EventDetail from './EventDetail';
import CalendarDayEvents from './CalendarDayEvents';
import { buildSubcalendarColorMap, eventChipStyle, eventOccursOnDay } from './calendarUtils';
import BrailleSpinner from '../BrailleSpinner';
import EmptyState from '../EmptyState';
import { useThemeContext } from '../ThemeContext';
import { formatMonthYear, formatTimeOfDay, formatDateFull, localDateKey } from '../../utils/formatters';
import useUrlParams from '../../hooks/useUrlParams';

function getMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = firstDay.getDay();
  const totalDays = lastDay.getDate();

  const cells = [];
  // Leading empty cells
  for (let i = 0; i < startOffset; i++) {
    const d = new Date(year, month, -startOffset + i + 1);
    cells.push({ date: d, isCurrentMonth: false });
  }
  // Current month
  for (let i = 1; i <= totalDays; i++) {
    cells.push({ date: new Date(year, month, i), isCurrentMonth: true });
  }
  // Trailing empty cells to fill 6 rows
  while (cells.length < 42) {
    const d = new Date(year, month + 1, cells.length - startOffset - totalDays + 1);
    cells.push({ date: d, isCurrentMonth: false });
  }
  return cells;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function MonthView({ accounts }) {
  const now = new Date();

  const [searchParams, updateParams] = useUrlParams();
  const { theme } = useThemeContext();
  const monthParam = searchParams.get('month');
  const monthKey = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(monthParam || '')
    ? monthParam : localDateKey(now).slice(0, 7);
  const [year, monthNumber] = monthKey.split('-').map(Number);
  const month = monthNumber - 1;

  const cells = getMonthGrid(year, month);
  const monthLabel = formatMonthYear(new Date(year, month));

  const last = cells[cells.length - 1].date;
  const startDate = cells[0].date.toISOString();
  const endDate = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).toISOString();
  const windowEvents = useCalendarWindowEvents(startDate, endDate);
  const { events, loading } = windowEvents;

  const navigate = (dir) => {
    updateParams({
      month: localDateKey(new Date(year, month + dir, 1)).slice(0, 7),
      day: null,
      event: null,
    });
  };

  const goToday = () => {
    updateParams({ month: localDateKey(now).slice(0, 7), day: null, event: null });
  };

  // The server returns a coarse range; place each event on every visible day it occupies.
  const eventsByDay = Object.fromEntries(cells.map(cell => [
    cell.date.toDateString(), events.filter(event => eventOccursOnDay(event, cell.date)),
  ]));

  const colorMap = useMemo(() => buildSubcalendarColorMap(accounts), [accounts]);
  const selectedEventKey = searchParams.get('event');
  const selectedEvent = events.find((event) => `${event.accountId}:${event.id}` === selectedEventKey) || null;
  const todayStr = now.toDateString();
  const dayTriggerRef = useRef(null);
  // Matching against the visible grid rejects impossible and stale day keys.
  const selectedDay = cells.find(cell => localDateKey(cell.date) === searchParams.get('day'));
  const openDay = (cell, trigger) => {
    dayTriggerRef.current = trigger;
    updateParams({ month: monthKey, day: localDateKey(cell.date), event: null });
  };

  const openEvent = (event) => updateParams({ month: monthKey, event: `${event.accountId}:${event.id}` });

  return (
    <div className="space-y-4">
      {/* Nav header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button aria-label="Previous month" onClick={() => navigate(-1)} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-white rounded hover:bg-port-border transition-colors">
            <ChevronLeft size={18} />
          </button>
          <button aria-label="Next month" onClick={() => navigate(1)} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-white rounded hover:bg-port-border transition-colors">
            <ChevronRight size={18} />
          </button>
          <h2 className="text-lg font-semibold text-white ml-2">{monthLabel}</h2>
        </div>
        <button onClick={goToday} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded hover:bg-port-border transition-colors">
          Today
        </button>
      </div>

      <CalendarWindowStatus {...windowEvents} />

      {loading && events.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <BrailleSpinner text="Loading" />
        </div>
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No calendar connected"
          message="Connect a calendar account to see your month."
          actionTo="/calendar/config"
          actionLabel="Add a calendar account"
        />
      ) : (
        <div className="border border-port-border rounded-lg overflow-hidden bg-port-card">
          {/* Day name headers */}
          <div className="grid grid-cols-7 border-b border-port-border">
            {DAY_NAMES.map(name => (
              <div key={name} className="text-center py-2 text-xs font-medium text-gray-400">
                {name}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7">
            {cells.map((cell, i) => {
              const dayStr = cell.date.toDateString();
              const dayEvents = eventsByDay[dayStr] || [];
              const isToday = dayStr === todayStr;
              return (
                <div
                  key={i}
                  className={`min-h-[80px] p-0 sm:p-1 min-w-0 border-b border-r border-port-border/50 ${
                    !cell.isCurrentMonth ? 'bg-port-bg/50' : ''
                  } ${i % 7 === 6 ? 'border-r-0' : ''}`}
                >
                  {dayEvents.length > 0 ? (
                    <button
                      type="button"
                      aria-label={`View day events for ${formatDateFull(cell.date)}`}
                      onClick={e => openDay(cell, e.currentTarget)}
                      className={`text-xs mb-0.5 w-[44px] h-[44px] flex items-center justify-center rounded hover:bg-port-border focus-visible:outline focus-visible:outline-port-accent ${isToday ? 'bg-port-accent text-white' : cell.isCurrentMonth ? 'text-gray-300' : 'text-gray-600'}`}
                    >
                      {cell.date.getDate()}
                    </button>
                  ) : (
                    <div className={`text-xs mb-0.5 h-[44px] flex items-center pl-1 ${isToday ? 'text-port-accent' : cell.isCurrentMonth ? 'text-gray-300' : 'text-gray-600'}`}>
                      {cell.date.getDate()}
                    </div>
                  )}
                  <div className="space-y-0.5">
                    {dayEvents.slice(0, 3).map(event => {
                      const evColor = colorMap.get(event.subcalendarId) || null;
                      return (
                        <button
                          key={`${event.accountId}-${event.id}`}
                          onClick={() => openEvent(event)}
                          className="w-full text-left px-1 py-0.5 rounded text-[10px] truncate transition-colors hover:brightness-125"
                          style={eventChipStyle(evColor, theme?.mode)}
                        >
                          {!event.isAllDay && (
                            <span className="text-gray-500 mr-1">
                              {new Date(event.startTime).toDateString() === dayStr
                                ? formatTimeOfDay(event.startTime) : 'Continues'}
                            </span>
                          )}
                          {event.title}
                        </button>
                      );
                    })}
                    {dayEvents.length > 3 && (
                      <button
                        type="button"
                        aria-label={`View all ${dayEvents.length} events for ${formatDateFull(cell.date)}`}
                        onClick={e => openDay(cell, e.currentTarget)}
                        className="w-full text-left text-[10px] text-port-accent pl-1 py-1 rounded hover:bg-port-border focus-visible:outline focus-visible:outline-port-accent"
                      >
                        +{dayEvents.length - 3} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <CalendarDayEvents
        date={selectedDay?.date}
        windowEvents={windowEvents}
        colorMap={colorMap}
        themeMode={theme?.mode}
        selectedEvent={selectedEvent}
        triggerRef={dayTriggerRef}
        onEvent={openEvent}
        onClose={() => updateParams({ day: null, event: null })}
      />
      {selectedEvent && <EventDetail event={selectedEvent} onClose={() => updateParams({ event: null })} />}
    </div>
  );
}
