import { useRef, useMemo } from 'react';
import {CalendarDays, ChevronLeft, ChevronRight} from 'lucide-react';
import { useCalendarWindowEvents } from '../../hooks/useCalendarWindowEvents';
import CalendarWindowStatus from './CalendarWindowStatus';
import EventDetail from './EventDetail';
import CalendarDayEvents from './CalendarDayEvents';
import ChronotypeOverlay from './ChronotypeOverlay';
import { buildSubcalendarColorMap, eventChipStyle, eventOccursOnDay, calendarDateFromParam } from './calendarUtils';
import { HOURS, PX_PER_HOUR, PX_PER_15MIN, START_HOUR, eventKey, getEventPosition, layoutEvents } from './calendarTimeGrid';
import BrailleSpinner from '../BrailleSpinner';
import EmptyState from '../EmptyState';
import { useThemeContext } from '../ThemeContext';
import { formatMonthDay, formatWeekdayShort, formatDateShort, formatHourOfDay, formatDateFull, localDateKey } from '../../utils/formatters';
import useUrlParams from '../../hooks/useUrlParams';

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

export default function WeekView({ accounts }) {
  const [searchParams, updateParams] = useUrlParams();
  const weekParam = searchParams.get('week');
  const weekStart = useMemo(() => getWeekStart(calendarDateFromParam(weekParam)), [weekParam]);
  const weekKey = localDateKey(weekStart);
  const dayTriggerRef = useRef(null);
  const { theme } = useThemeContext();

  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart]);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekStartIso = weekStart.toISOString();
  const weekEndIso = weekEnd.toISOString();

  const windowEvents = useCalendarWindowEvents(weekStartIso, weekEndIso);
  const { events, loading } = windowEvents;

  const navigate = (weeks) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + weeks * 7);
    updateParams({ week: localDateKey(d), day: null, event: null });
  };

  const goToday = () => updateParams({ week: localDateKey(getWeekStart(new Date())), day: null, event: null });
  const openEvent = event => updateParams({ week: weekKey, event: `${event.accountId}:${event.id}` });
  const selectedDay = weekDays.find(day => localDateKey(day) === searchParams.get('day'));

  const colorMap = useMemo(() => buildSubcalendarColorMap(accounts), [accounts]);
  const selectedEventKey = searchParams.get('event');
  const selectedEvent = events.find((event) => `${event.accountId}:${event.id}` === selectedEventKey) || null;

  // Group events by day
  const eventsByDay = useMemo(() => weekDays.map(day =>
    events.filter(e => !e.isAllDay && eventOccursOnDay(e, day))
  ), [events, weekDays]);

  const allDayByDay = useMemo(() => weekDays.map(day =>
    events.filter(e => e.isAllDay && eventOccursOnDay(e, day))
  ), [events, weekDays]);

  // Memoize layouts per day
  const layoutsByDay = useMemo(
    () => eventsByDay.map((dayEvents, index) => layoutEvents(dayEvents, weekDays[index])),
    [eventsByDay, weekDays]
  );

  const now = new Date();
  const todayStr = now.toDateString();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowTop = (nowMinutes / 60) * PX_PER_HOUR;

  const weekLabel = `${formatMonthDay(weekDays[0])} - ${formatDateShort(weekDays[6])}`;

  return (
    <div className="space-y-4">
      {/* Nav header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <button aria-label="Previous week" onClick={() => navigate(-1)} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-white rounded hover:bg-port-border transition-colors">
            <ChevronLeft size={18} />
          </button>
          <button aria-label="Next week" onClick={() => navigate(1)} className="p-1.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-white rounded hover:bg-port-border transition-colors">
            <ChevronRight size={18} />
          </button>
          <h2 className="text-lg font-semibold text-white ml-2">{weekLabel}</h2>
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
          message="Connect a calendar account to see your week."
          actionTo="/calendar/config"
          actionLabel="Add a calendar account"
        />
      ) : (
        <div className="-mx-2 sm:mx-0 border border-port-border rounded-lg overflow-auto bg-port-card">
          {/* Keep every row aligned even when seven touch targets need horizontal scrolling. */}
          <div className="min-w-[324px] sm:min-w-[364px]">
          {/* Day headers */}
          <div className="flex border-b border-port-border sticky top-0 bg-port-card z-10">
            <div className="w-4 sm:w-14 shrink-0" />
            {weekDays.map((day, i) => {
              const isToday = day.toDateString() === todayStr;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`View day events for ${formatDateFull(day)}`}
                  onClick={e => {
                    dayTriggerRef.current = e.currentTarget;
                    updateParams({ week: weekKey, day: localDateKey(day), event: null });
                  }}
                  className={`flex-1 min-w-[44px] min-h-[44px] text-center py-2 text-xs font-medium border-l border-port-border ${isToday ? 'text-port-accent' : 'text-gray-400'}`}
                >
                  <div>{formatWeekdayShort(day)}</div>
                  <div className={`text-lg ${isToday ? 'bg-port-accent text-white rounded-full w-8 h-8 flex items-center justify-center mx-auto' : ''}`}>
                    {day.getDate()}
                  </div>
                </button>
              );
            })}
          </div>

          {/* All-day row */}
          {allDayByDay.some(d => d.length > 0) && (
            <div className="flex border-b border-port-border">
              <div className="w-4 sm:w-14 shrink-0 text-[10px] text-gray-500 text-right pr-1 pt-1"><span className="hidden sm:inline">All day</span></div>
              {allDayByDay.map((dayEvents, i) => (
                <div key={i} className="flex-1 min-w-0 border-l border-port-border p-0.5 min-h-[28px]">
                  {dayEvents.map(event => {
                    const adColor = colorMap.get(event.subcalendarId) || null;
                    return (
                      <button
                        key={eventKey(event)}
                          onClick={() => openEvent(event)}
                        className="w-full text-left px-1 py-0.5 rounded text-[10px] truncate transition-colors hover:brightness-125"
                        style={eventChipStyle(adColor, theme?.mode)}
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
                <div className="w-4 sm:w-14 shrink-0 text-[10px] text-gray-500 text-right pr-1 -mt-1.5">
                  <span className="hidden sm:inline">{formatHourOfDay(hour)}</span>
                  <span className="sm:hidden text-[8px]" aria-label={formatHourOfDay(hour)}>{hour}</span>
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
            <div className="absolute top-0 bottom-0 left-4 sm:left-14 right-0">
              <ChronotypeOverlay startHour={START_HOUR} pxPerHour={PX_PER_HOUR} />
            </div>

            {/* Events overlay per column */}
            <div className="absolute top-0 bottom-0 left-4 sm:left-14 right-0 flex">
              {eventsByDay.map((dayEvents, dayIndex) => {
                const isToday = weekDays[dayIndex].toDateString() === todayStr;
                const layout = layoutsByDay[dayIndex];
                return (
                  <div key={dayIndex} className="flex-1 relative border-l border-port-border/50">
                    {dayEvents.map(event => {
                      const { top, height } = getEventPosition(event, weekDays[dayIndex]);
                      const key = eventKey(event);
                      const { column, totalColumns } = layout.get(key) || { column: 0, totalColumns: 1 };
                      const widthPercent = 100 / totalColumns;
                      const leftPercent = column * widthPercent;
                      const evColor = colorMap.get(event.subcalendarId) || null;
                      return (
                        <button
                          key={key}
                          onClick={() => openEvent(event)}
                          className={`absolute px-0.5 py-0.5 border-l-2 rounded text-left overflow-hidden transition-colors ${evColor ? 'hover:brightness-125' : 'hover:bg-port-accent/30'}`}
                          style={{
                            top,
                            height,
                            left: `calc(${leftPercent}% + 1px)`,
                            width: `calc(${widthPercent}% - 2px)`,
                            ...eventChipStyle(evColor, theme?.mode)
                          }}
                        >
                          {/* Title inherits the graded color from the block. It must NOT
                              carry `text-white`: day mode remaps that utility with
                              `!important`, which beats the inline color. */}
                          <div className="text-[10px] leading-tight font-medium truncate">{event.title}</div>
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
        </div>
      )}

      <CalendarDayEvents
        date={selectedDay}
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
