import { useState, useEffect, useCallback, useMemo } from 'react';
import {CalendarDays, ChevronLeft, ChevronRight, MapPin} from 'lucide-react';
import * as api from '../../services/api';
import socket from '../../services/socket';
import EventDetail from './EventDetail';
import ChronotypeOverlay from './ChronotypeOverlay';
import { buildSubcalendarColorMap, eventChipStyle, eventOccursOnDay } from './calendarUtils';
import { HOURS, PX_PER_HOUR, PX_PER_15MIN, START_HOUR, eventKey, getEventPosition, layoutEvents } from './calendarTimeGrid';
import { formatDateFull, formatHourOfDay } from '../../utils/formatters';
import BrailleSpinner from '../BrailleSpinner';
import EmptyState from '../EmptyState';
import { useThemeContext } from '../ThemeContext';
import useUrlParams from '../../hooks/useUrlParams';

export default function DayView({ accounts }) {
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, updateParams] = useUrlParams();
  const { theme } = useThemeContext();

  const fetchEvents = useCallback(async () => {
    const startDate = date.toISOString();
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    const endDate = nextDay.toISOString();
    const data = await api.getCalendarEvents({ startDate, endDate, limit: 200 }).catch(() => ({ events: [] }));
    setEvents(data?.events || []);
    setLoading(false);
  }, [date]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);
  useEffect(() => {
    socket.on('calendar:sync:completed', fetchEvents);
    return () => socket.off('calendar:sync:completed', fetchEvents);
  }, [fetchEvents]);

  const navigate = (days) => {
    setDate(prev => {
      const d = new Date(prev);
      d.setDate(d.getDate() + days);
      return d;
    });
    setLoading(true);
  };

  const goToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setDate(d);
    setLoading(true);
  };

  const allDayEvents = useMemo(() => events.filter(e => e.isAllDay && eventOccursOnDay(e, date)), [events, date]);
  const timedEvents = useMemo(() => events.filter(e => !e.isAllDay && eventOccursOnDay(e, date)), [events, date]);
  const layout = useMemo(() => layoutEvents(timedEvents, date), [timedEvents, date]);
  const colorMap = useMemo(() => buildSubcalendarColorMap(accounts), [accounts]);
  const selectedEventKey = searchParams.get('event');
  const selectedEvent = events.find((event) => `${event.accountId}:${event.id}` === selectedEventKey) || null;

  // Current time indicator — update every 60s so the red line moves
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const isToday = date.toDateString() === now.toDateString();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowTop = (nowMinutes / 60) * PX_PER_HOUR;

  return (
    <div className="space-y-4">
      {/* Nav header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button aria-label="Previous day" onClick={() => navigate(-1)} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-white rounded hover:bg-port-border transition-colors">
            <ChevronLeft size={18} />
          </button>
          <button aria-label="Next day" onClick={() => navigate(1)} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-white rounded hover:bg-port-border transition-colors">
            <ChevronRight size={18} />
          </button>
          <h2 className="text-lg font-semibold text-white ml-2">{formatDateFull(date)}</h2>
        </div>
        <button onClick={goToday} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded hover:bg-port-border transition-colors">
          Today
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <BrailleSpinner text="Loading" />
        </div>
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="No calendar connected"
          message="Connect a calendar account to see your day."
          actionTo="/calendar/config"
          actionLabel="Add a calendar account"
        />
      ) : (
        <>
          {/* All-day events */}
          {allDayEvents.length > 0 && (
            <div className="space-y-1">
              <span className="text-xs text-gray-500 uppercase">All Day</span>
              {allDayEvents.map(event => {
                const adColor = colorMap.get(event.subcalendarId) || null;
                return (
                  <button
                    key={`${event.accountId}-${event.id}`}
                    onClick={() => updateParams({ event: `${event.accountId}:${event.id}` })}
                    className="w-full text-left px-3 py-2 rounded text-sm transition-colors hover:brightness-125"
                    style={eventChipStyle(adColor, theme?.mode)}
                  >
                    {event.title}
                  </button>
                );
              })}
            </div>
          )}

          {/* Time grid */}
          <div className="relative border border-port-border rounded-lg overflow-hidden bg-port-card">
            {HOURS.map(hour => (
              <div key={hour} className="border-b border-port-border last:border-b-0" style={{ height: PX_PER_HOUR }}>
                <div className="flex h-full">
                  <div className="w-16 shrink-0 text-xs text-gray-500 text-right pr-2 pt-1">
                    {formatHourOfDay(hour)}
                  </div>
                  <div className="flex-1 border-l border-port-border flex flex-col">
                    {[0, 1, 2, 3].map(q => (
                      <div
                        key={q}
                        className={`flex-1 ${q > 0 ? 'border-t border-port-border/30' : ''}`}
                        style={{ height: PX_PER_15MIN }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ))}

            {/* Events overlay */}
            <div className="absolute top-0 left-16 right-0 bottom-0">
              {/* Chronotype energy zones (behind events) */}
              <ChronotypeOverlay startHour={START_HOUR} pxPerHour={PX_PER_HOUR} />

              {timedEvents.map(event => {
                const { top, height } = getEventPosition(event, date);
                const key = eventKey(event);
                const { column, totalColumns } = layout.get(key) || { column: 0, totalColumns: 1 };
                const widthPercent = 100 / totalColumns;
                const leftPercent = column * widthPercent;
                const eventColor = colorMap.get(event.subcalendarId) || null;
                return (
                  <button
                    key={key}
                    onClick={() => updateParams({ event: `${event.accountId}:${event.id}` })}
                    className={`absolute px-1.5 py-0.5 border-l-2 rounded text-left overflow-hidden transition-colors ${eventColor ? 'hover:brightness-125' : 'hover:bg-port-accent/30'}`}
                    style={{
                      top,
                      height,
                      left: `calc(${leftPercent}% + 2px)`,
                      width: `calc(${widthPercent}% - 4px)`,
                      ...eventChipStyle(eventColor, theme?.mode)
                    }}
                  >
                    {/* Title inherits the graded color from the block. It must NOT
                        carry `text-white`: day mode remaps that utility with
                        `!important`, which beats the inline color. */}
                    <div className="text-xs leading-tight font-medium truncate">{event.title}</div>
                    {height > 32 && event.location && (
                      <div className="flex items-center gap-1 text-[10px] text-gray-400 truncate">
                        <MapPin size={10} /> {event.location}
                      </div>
                    )}
                  </button>
                );
              })}

              {/* Current time line */}
              {isToday && nowTop >= 0 && nowTop <= HOURS.length * PX_PER_HOUR && (
                <div className="absolute left-0 right-0 flex items-center pointer-events-none" style={{ top: nowTop }}>
                  <div className="w-2 h-2 rounded-full bg-port-error -ml-1" />
                  <div className="flex-1 h-px bg-port-error" />
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {selectedEvent && <EventDetail event={selectedEvent} onClose={() => updateParams({ event: null })} />}
    </div>
  );
}
