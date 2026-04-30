import { useState, useEffect, useCallback, useMemo } from 'react';
import {ChevronLeft, ChevronRight, MapPin} from 'lucide-react';
import * as api from '../../services/api';
import socket from '../../services/socket';
import EventDetail from './EventDetail';
import ChronotypeOverlay from './ChronotypeOverlay';
import { buildSubcalendarColorMap } from './calendarUtils';
import { formatDateFull } from '../../utils/formatters';
import BrailleSpinner from '../BrailleSpinner';

const START_HOUR = 6;
const END_HOUR = 23;
const HOURS = Array.from({ length: END_HOUR - START_HOUR }, (_, i) => i + START_HOUR); // 6am to 10pm
const PX_PER_HOUR = 80;
const PX_PER_15MIN = PX_PER_HOUR / 4; // 20px per 15-min block
const START_MINUTES = START_HOUR * 60;

function formatHour(hour) {
  if (hour === 0) return '12 AM';
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
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

/**
 * Assign columns to overlapping events so they render side-by-side.
 * Returns a Map of eventKey -> { column, totalColumns }
 */
function layoutEvents(events) {
  const items = events.map(e => {
    const { startMin, endMin } = getEventMinutes(e);
    return { event: e, startMin, endMin: Math.max(endMin, startMin + 15) };
  }).sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const groups = []; // groups of overlapping events
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
    // Assign columns greedily
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
    // Set totalColumns for all events in this group
    const total = columns.length;
    for (const item of group) {
      const l = layout.get(eventKey(item.event));
      if (l) l.totalColumns = total;
    }
  }
  return layout;
}

function eventKey(e) {
  return `${e.accountId}-${e.id}`;
}

export default function DayView({ accounts }) {
  const [date, setDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState(null);

  const fetchEvents = useCallback(async () => {
    const startDate = date.toISOString();
    const endDate = new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString();
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

  const allDayEvents = useMemo(() => events.filter(e => e.isAllDay), [events]);
  const timedEvents = useMemo(() => events.filter(e => !e.isAllDay), [events]);
  const layout = useMemo(() => layoutEvents(timedEvents), [timedEvents]);
  const colorMap = useMemo(() => buildSubcalendarColorMap(accounts), [accounts]);

  // Current time indicator — update every 60s so the red line moves
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const isToday = date.toDateString() === now.toDateString();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowTop = ((nowMinutes - START_MINUTES) / 60) * PX_PER_HOUR;

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
                    onClick={() => setSelectedEvent(event)}
                    className="w-full text-left px-3 py-2 rounded text-sm transition-colors hover:brightness-125"
                    style={{
                      backgroundColor: adColor ? `${adColor}20` : 'rgb(59 130 246 / 0.1)',
                      color: adColor || 'var(--port-accent, #3b82f6)'
                    }}
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
                    {formatHour(hour)}
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
                const { top, height } = getEventPosition(event);
                const key = eventKey(event);
                const { column, totalColumns } = layout.get(key) || { column: 0, totalColumns: 1 };
                const widthPercent = 100 / totalColumns;
                const leftPercent = column * widthPercent;
                const eventColor = colorMap.get(event.subcalendarId) || null;
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedEvent(event)}
                    className={`absolute px-1.5 py-0.5 border-l-2 rounded text-left overflow-hidden transition-colors ${eventColor ? 'hover:brightness-125' : 'hover:bg-port-accent/30'}`}
                    style={{
                      top,
                      height,
                      minHeight: PX_PER_15MIN,
                      left: `calc(${leftPercent}% + 2px)`,
                      width: `calc(${widthPercent}% - 4px)`,
                      borderLeftColor: eventColor || 'var(--port-accent, #3b82f6)',
                      backgroundColor: eventColor ? `${eventColor}25` : 'rgb(59 130 246 / 0.2)'
                    }}
                  >
                    <div className="text-xs leading-tight font-medium text-white truncate">{event.title}</div>
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

      {selectedEvent && <EventDetail event={selectedEvent} onClose={() => setSelectedEvent(null)} />}
    </div>
  );
}
