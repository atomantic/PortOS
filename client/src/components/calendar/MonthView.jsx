import { useState, useEffect, useMemo } from 'react';
import {ChevronLeft, ChevronRight} from 'lucide-react';
import * as api from '../../services/api';
import socket from '../../services/socket';
import EventDetail from './EventDetail';
import Drawer from '../Drawer';
import { buildSubcalendarColorMap, eventChipStyle } from './calendarUtils';
import BrailleSpinner from '../BrailleSpinner';
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

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, updateParams] = useUrlParams();
  const { theme } = useThemeContext();
  const monthParam = searchParams.get('month');
  const monthKey = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(monthParam || '')
    ? monthParam : localDateKey(now).slice(0, 7);
  const [year, monthNumber] = monthKey.split('-').map(Number);
  const month = monthNumber - 1;

  const cells = getMonthGrid(year, month);
  const monthLabel = formatMonthYear(new Date(year, month));

  useEffect(() => {
    let active = true;
    let request = 0;
    const fetchEvents = async () => {
      const currentRequest = ++request;
      const grid = getMonthGrid(year, month);
      const last = grid[grid.length - 1].date;
      const startDate = grid[0].date.toISOString();
      const endDate = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1).toISOString();
      const data = await api.getCalendarEvents({ startDate, endDate, limit: 500 }).catch(() => ({ events: [] }));
      if (!active || currentRequest !== request) return;
      setEvents(data?.events || []);
      setLoading(false);
    };
    setEvents([]);
    setLoading(true);
    fetchEvents();
    socket.on('calendar:sync:completed', fetchEvents);
    return () => {
      active = false;
      socket.off('calendar:sync:completed', fetchEvents);
    };
  }, [year, month]);

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

  // Group events by day string
  const eventsByDay = {};
  for (const event of events) {
    const dayKey = new Date(event.startTime).toDateString();
    if (!eventsByDay[dayKey]) eventsByDay[dayKey] = [];
    eventsByDay[dayKey].push(event);
  }

  const colorMap = useMemo(() => buildSubcalendarColorMap(accounts), [accounts]);
  const selectedEventKey = searchParams.get('event');
  const selectedEvent = events.find((event) => `${event.accountId}:${event.id}` === selectedEventKey) || null;
  const todayStr = now.toDateString();
  // Matching against the visible grid rejects impossible and stale day keys.
  const selectedDay = cells.find(cell => localDateKey(cell.date) === searchParams.get('day'));
  const selectedDayEvents = [...(eventsByDay[selectedDay?.date.toDateString()] || [])]
    .sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || new Date(a.startTime) - new Date(b.startTime));
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

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <BrailleSpinner text="Loading" />
        </div>
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
                  className={`min-h-[80px] p-1 border-b border-r border-port-border/50 ${
                    !cell.isCurrentMonth ? 'bg-port-bg/50' : ''
                  } ${i % 7 === 6 ? 'border-r-0' : ''}`}
                >
                  <div className={`text-xs mb-0.5 ${
                    isToday
                      ? 'bg-port-accent text-white rounded-full w-6 h-6 flex items-center justify-center'
                      : cell.isCurrentMonth ? 'text-gray-300' : 'text-gray-600'
                  }`}>
                    {cell.date.getDate()}
                  </div>
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
                              {formatTimeOfDay(event.startTime)}
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
                        onClick={() => updateParams({ month: monthKey, day: localDateKey(cell.date), event: null })}
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

      <Drawer
        open={!!selectedDay && !selectedEvent}
        onClose={() => updateParams({ day: null, event: null })}
        title={selectedDay ? formatDateFull(selectedDay.date) : ''}
        subtitle={`${selectedDayEvents.length} events`}
        closeLabel="Close day events"
      >
        {loading ? <BrailleSpinner text="Loading" /> : (
          <div className="space-y-2">
            {selectedDayEvents.length === 0 && <p className="text-sm text-gray-400">No events available for this date.</p>}
            {selectedDayEvents.map(event => (
              <button
                key={`${event.accountId}:${event.id}`}
                type="button"
                onClick={() => openEvent(event)}
                className="w-full min-h-[44px] text-left px-3 py-2 rounded transition-colors hover:brightness-125"
                style={eventChipStyle(colorMap.get(event.subcalendarId) || null, theme?.mode)}
              >
                <span className="block text-xs">{event.isAllDay ? 'All day' : formatTimeOfDay(event.startTime)}</span>
                <span className="block text-sm break-words">{event.title}</span>
              </button>
            ))}
          </div>
        )}
      </Drawer>
      {selectedEvent && <EventDetail event={selectedEvent} onClose={() => updateParams({ event: null })} />}
    </div>
  );
}
