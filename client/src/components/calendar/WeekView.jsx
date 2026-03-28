import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import * as api from '../../services/api';
import socket from '../../services/socket';
import EventDetail from './EventDetail';
import ChronotypeOverlay from './ChronotypeOverlay';
import { buildSubcalendarColorMap } from './calendarUtils';

const START_HOUR = 6;
const END_HOUR = 23;
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => i + START_HOUR);
const PX_PER_HOUR = 80;
const PX_PER_15MIN = PX_PER_HOUR / 4; // 20px per 15-min block
const START_MINUTES = START_HOUR * 60;

function formatHour(hour) {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function getEventMinutes(event) {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  return {
    startMin: start.getHours() * 60 + start.getMinutes(),
    endMin: end.getHours() * 60 + end.getMinutes()
  };
}

function getEventPosition(event) {
  const { startMin, endMin } = getEventMinutes(event);
  const top = ((startMin - START_MINUTES) / 60) * PX_PER_HOUR;
  const height = Math.max(((endMin - startMin) / 60) * PX_PER_HOUR, PX_PER_15MIN);
  return { top: Math.max(top, 0), height };
}

function eventKey(e) {
  return `${e.accountId}-${e.id}`;
}

function layoutEvents(events) {
  const items = events.map(e => {
    const { startMin, endMin } = getEventMinutes(e);
    return { event: e, startMin, endMin: Math.max(endMin, startMin + 15) };
  }).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const groups = [];
  let currentGroup = [];
  let groupEnd = -1;

  for (const item of items) {
    if (currentGroup.length === 0 || item.startMin < groupEnd) {
      currentGroup.push(item);
      groupEnd = Math.max(groupEnd, item.endMin);
    } else {
      groups.push(currentGroup);
      currentGroup = [item];
      groupEnd = item.endMin;
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  const layout = new Map();
  for (const group of groups) {
    const columns = [];
    for (const item of group) {
      let placed = false;
      for (let col = 0; col < columns.length; col++) {
        if (columns[col] <= item.startMin) {
          columns[col] = item.endMin;
          layout.set(eventKey(item.event), { column: col, totalColumns: 0 });
          placed = true;
          break;
        }
      }
      if (!placed) {
        layout.set(eventKey(item.event), { column: columns.length, totalColumns: 0 });
        columns.push(item.endMin);
      }
    }
    const total = columns.length;
    for (const item of group) {
      const l = layout.get(eventKey(item.event));
      if (l) l.totalColumns = total;
    }
  }
  return layout;
}



export default function WeekView({ accounts }) {
  const [weekStart, setWeekStart] = useState(() => getWeekStart(new Date()));
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);

  const weekDays = getWeekDays(weekStart);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekStartIso = weekStart.toISOString();
  const weekEndIso = weekEnd.toISOString();

  const fetchEvents = useCallback(async () => {
    const data = await api.getCalendarEvents({
      startDate: weekStartIso,
      endDate: weekEndIso,
      limit: 200
    }).catch(() => ({ events: [] }));
    setEvents(data?.events || []);
    setLoading(false);
  }, [weekEndIso, weekStartIso]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);
  useEffect(() => {
    socket.on('calendar:sync:completed', fetchEvents);
    return () => socket.off('calendar:sync:completed', fetchEvents);
  }, [fetchEvents]);

  const navigate = (weeks) => {
    setWeekStart(prev => {
      const d = new Date(prev);
      d.setDate(d.getDate() + weeks * 7);
      return d;
    });
    setLoading(true);
  };

  const goToday = () => {
    setWeekStart(getWeekStart(new Date()));
    setLoading(true);
  };

  const colorMap = useMemo(() => buildSubcalendarColorMap(accounts), [accounts]);

  // Group events by day
  const eventsByDay = useMemo(() => weekDays.map(day => {
    const dayStr = day.toDateString();
    return events.filter(e => !e.isAllDay && new Date(e.startTime).toDateString() === dayStr);
  }), [events, weekDays]);

  const allDayByDay = useMemo(() => weekDays.map(day => {
    const dayStr = day.toDateString();
    return events.filter(e => e.isAllDay && new Date(e.startTime).toDateString() === dayStr);
  }), [events, weekDays]);

  // Memoize layouts per day
  const layoutsByDay = useMemo(
    () => eventsByDay.map(dayEvents => layoutEvents(dayEvents)),
    [eventsByDay]
  );

  const now = new Date();
  const todayStr = now.toDateString();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowTop = ((nowMinutes - START_MINUTES) / 60) * PX_PER_HOUR;

  const weekLabel = `${weekDays[0].toLocaleDateString([], { month: 'short', day: 'numeric' })} - ${weekDays[6].toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <div className="space-y-4">
      {/* Nav header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => navigate(-1)} className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-port-border transition-colors">
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => navigate(1)} className="p-1.5 text-gray-400 hover:text-white rounded hover:bg-port-border transition-colors">
            <ChevronRight size={18} />
          </button>
          <h2 className="text-lg font-semibold text-white ml-2">{weekLabel}</h2>
        </div>
        <button onClick={goToday} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded hover:bg-port-border transition-colors">
          Today
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw size={24} className="text-port-accent animate-spin" />
        </div>
      ) : (
        <div className="border border-port-border rounded-lg overflow-auto bg-port-card">
          {/* Day headers */}
          <div className="flex border-b border-port-border sticky top-0 bg-port-card z-10">
            <div className="w-14 shrink-0" />
            {weekDays.map((day, i) => {
              const isToday = day.toDateString() === todayStr;
              return (
                <div
                  key={i}
                  className={`flex-1 text-center py-2 text-xs font-medium border-l border-port-border ${isToday ? 'text-port-accent' : 'text-gray-400'}`}
                >
                  <div>{day.toLocaleDateString([], { weekday: 'short' })}</div>
                  <div className={`text-lg ${isToday ? 'bg-port-accent text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto' : ''}`}>
                    {day.getDate()}
                  </div>
                </div>
              );
            })}
          </div>

          {/* All-day row */}
          {allDayByDay.some(d => d.length > 0) && (
            <div className="flex border-b border-port-border">
              <div className="w-14 shrink-0 text-[10px] text-gray-500 text-right pr-1 pt-1">All day</div>
              {allDayByDay.map((dayEvents, i) => (
                <div key={i} className="flex-1 border-l border-port-border p-0.5 min-h-[28px]">
                  {dayEvents.map(event => {
                    const adColor = colorMap.get(event.subcalendarId) || null;
                    return (
                      <button
                        key={eventKey(event)}
                        onClick={() => setSelectedEvent(event)}
                        className="w-full text-left px-1 py-0.5 rounded text-[10px] truncate transition-colors hover:brightness-125"
                        style={{
                          backgroundColor: adColor ? `${adColor}20` : 'rgb(59 130 246 / 0.15)',
                          color: adColor || 'var(--port-accent, #3b82f6)'
                        }}
                      >
                        {event.title}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* Time grid */}
          <div className="relative">
            {HOURS.map(hour => (
              <div key={hour} className="flex border-b border-port-border/50 last:border-b-0" style={{ height: PX_PER_HOUR }}>
                <div className="w-14 shrink-0 text-[10px] text-gray-500 text-right pr-1 -mt-1.5">
                  {formatHour(hour)}
                </div>
                {weekDays.map((_, i) => (
                  <div key={i} className="flex-1 border-l border-port-border/50 flex flex-col">
                    {[0, 1, 2, 3].map(q => (
                      <div
                        key={q}
                        className={`flex-1 ${q > 0 ? 'border-t border-port-border/20' : ''}`}
                        style={{ height: PX_PER_15MIN }}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}

            {/* Chronotype energy zones (behind events) */}
            <div className="absolute top-0 bottom-0 left-14 right-0">
              <ChronotypeOverlay startHour={START_HOUR} pxPerHour={PX_PER_HOUR} />
            </div>

            {/* Events overlay per column */}
            <div className="absolute top-0 bottom-0 left-14 right-0 flex">
              {eventsByDay.map((dayEvents, dayIndex) => {
                const isToday = weekDays[dayIndex].toDateString() === todayStr;
                const layout = layoutsByDay[dayIndex];
                return (
                  <div key={dayIndex} className="flex-1 relative border-l border-port-border/50">
                    {dayEvents.map(event => {
                      const { top, height } = getEventPosition(event);
                      const key = eventKey(event);
                      const { column, totalColumns } = layout.get(key) || { column: 0, totalColumns: 1 };
                      const widthPercent = 100 / totalColumns;
                      const leftPercent = column * widthPercent;
                      const evColor = colorMap.get(event.subcalendarId) || null;
                      return (
                        <button
                          key={key}
                          onClick={() => setSelectedEvent(event)}
                          className={`absolute px-0.5 py-0.5 border-l-2 rounded text-left overflow-hidden transition-colors ${evColor ? 'hover:brightness-125' : 'hover:bg-port-accent/30'}`}
                          style={{
                            top,
                            height,
                            minHeight: PX_PER_15MIN,
                            left: `calc(${leftPercent}% + 1px)`,
                            width: `calc(${widthPercent}% - 2px)`,
                            borderLeftColor: evColor || 'var(--port-accent, #3b82f6)',
                            backgroundColor: evColor ? `${evColor}25` : 'rgb(59 130 246 / 0.2)'
                          }}
                        >
                          <div className="text-[10px] leading-tight font-medium text-white truncate">{event.title}</div>
                        </button>
                      );
                    })}
                    {/* Current time line */}
                    {isToday && nowTop >= 0 && nowTop <= HOURS.length * PX_PER_HOUR && (
                      <div className="absolute left-0 right-0 flex items-center pointer-events-none z-10" style={{ top: nowTop }}>
                        <div className="w-1.5 h-1.5 rounded-full bg-port-error -ml-0.5" />
                        <div className="flex-1 h-px bg-port-error" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {selectedEvent && <EventDetail event={selectedEvent} onClose={() => setSelectedEvent(null)} />}
    </div>
  );
}
