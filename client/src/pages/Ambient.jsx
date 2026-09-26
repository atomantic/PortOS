import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { ArrowLeft, Maximize, Minimize } from 'lucide-react';
import * as api from '../services/api';
import { useSocketResource } from '../hooks/useSocketResource';
import { useSocket } from '../hooks/useSocket';
import { formatClockTime, formatDateFull, formatTimeOfDay } from '../utils/formatters';
import DeathClockCountdown from '../components/DeathClockCountdown';

const CALENDAR_EVENTS = ['calendar:sync:completed'];
const DEATH_CLOCK_EVENTS = ['meatspace:death-clock:changed'];
const GOAL_EVENTS = ['cos:goals:changed'];
const SUMMARY_EVENTS = ['cos:status', 'cos:status:paused', 'cos:status:resumed', 'cos:agent:spawned', 'cos:agent:updated', 'cos:agent:completed'];
const IDLE_DELAY = 3000;

const goalColor = (rate) =>
  rate >= 80 ? 'rgb(var(--port-success))' : rate >= 50 ? 'rgb(var(--port-warning))' : 'rgb(var(--port-error))';

const goalColorClass = (rate) =>
  rate >= 80 ? 'text-port-success' : rate >= 50 ? 'text-port-warning' : 'text-port-error';

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
}

export default function Ambient() {
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());
  const [idle, setIdle] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const idleTimer = useRef(null);

  const socket = useSocket();
  const day = time.toDateString();
  // A tab may resume after midnight before its next clock tick. Reads record
  // their own day so the tick cannot duplicate reconnect/tab-show reconciliation.
  const reconciledDays = useRef({ deathClock: day, summary: day, calendar: day });
  const { data: deathData, refetch: refreshDeathClock } = useSocketResource(() => {
    reconciledDays.current.deathClock = new Date().toDateString();
    return api.getDeathClock();
  }, {
    events: DEATH_CLOCK_EVENTS
  });
  const { data: cosSummary, refetch: refreshSummary } = useSocketResource(() => {
    reconciledDays.current.summary = new Date().toDateString();
    return api.getCosQuickSummary({ silent: true });
  }, {
    namespace: 'cos', events: SUMMARY_EVENTS
  });
  const { data: goals } = useSocketResource(() => api.getCosGoalProgressSummary({ silent: true }), {
    namespace: 'cos', events: GOAL_EVENTS
  });
  const { data: calendarEvents, refetch: refreshCalendar } = useSocketResource(async () => {
    const now = new Date();
    reconciledDays.current.calendar = now.toDateString();
    const params = {
      startDate: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
      endDate: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
      limit: 200
    };
    const events = [];
    let page;
    do {
      page = await api.getCalendarEvents({ ...params, offset: events.length });
      events.push(...page.events);
    } while (page.events.length && events.length < page.total);
    return events;
  }, { events: CALENDAR_EVENTS });

  useEffect(() => {
    if (document.visibilityState === 'hidden') return;
    if (reconciledDays.current.deathClock !== day) refreshDeathClock();
    if (reconciledDays.current.summary !== day) refreshSummary();
    if (reconciledDays.current.calendar !== day) refreshCalendar();
  }, [day, refreshDeathClock, refreshSummary, refreshCalendar]);

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') navigate('/');
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  useEffect(() => {
    const resetIdle = () => {
      setIdle(false);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setIdle(true), IDLE_DELAY);
    };
    window.addEventListener('mousemove', resetIdle);
    window.addEventListener('touchstart', resetIdle);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_DELAY);
    return () => {
      window.removeEventListener('mousemove', resetIdle);
      window.removeEventListener('touchstart', resetIdle);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleChange);
    return () => document.removeEventListener('fullscreenchange', handleChange);
  }, []);

  const today = useMemo(() => cosSummary?.today || {}, [cosSummary]);

  const upcomingEvents = useMemo(() => {
    const events = Array.isArray(calendarEvents) ? calendarEvents : [];
    return events
      .filter(e => new Date(e.endTime || e.end || e.startTime || e.start) >= time)
      .slice(0, 6);
  }, [calendarEvents, time]);

  return (
    // Ambient mode is a full-screen always-on display for a dim room, so it
    // stays black rather than following the theme — every layer below is white
    // text on black, and a day theme's light surface would leave it unreadable.
    <div className={`fixed inset-0 bg-black text-white z-[9999] overflow-hidden flex flex-col ${idle ? 'cursor-none' : ''}`}>
      <div className={`absolute top-4 left-4 right-4 flex justify-between items-center z-10 transition-opacity duration-500 ${
        idle ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}>
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-sm text-gray-400 hover:text-white min-h-[40px]"
        >
          <ArrowLeft size={16} />
          <span>Exit</span>
        </button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-600">ESC to exit &middot; F for fullscreen</span>
          <button
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors text-gray-400 hover:text-white min-h-[40px] min-w-[40px] flex items-center justify-center"
          >
            {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 overscroll-contain">
        <div className="min-h-full flex flex-col items-center justify-center p-8 gap-8">
        <div className="text-center">
          <div className="text-7xl sm:text-8xl md:text-9xl font-mono font-light tracking-wider text-white/90 tabular-nums">
            {formatClockTime(time)}
          </div>
          <div className="text-lg sm:text-xl text-gray-500 mt-2 tracking-wide">
            {formatDateFull(time)}
          </div>
        </div>

        {deathData?.deathDate && (
          <div className="text-center">
            <DeathClockCountdown
              deathDate={deathData.deathDate}
              size="lg"
              align="center"
            />
            {deathData.percentComplete != null && (
              <div className="text-xs text-gray-700 mt-1">
                {deathData.percentComplete}% of est. meatspace time elapsed
              </div>
            )}
          </div>
        )}

        <div className="w-full max-w-5xl grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
          <AmbientPanel title="Today" count={upcomingEvents.length}>
            {upcomingEvents.length === 0 ? (
              <div className="text-gray-600 text-sm">No upcoming events</div>
            ) : (
              <div className="space-y-2">
                {upcomingEvents.map((event, i) => (
                  <div key={event.id || i} className="flex items-start gap-3">
                    <div
                      className="w-1 h-6 rounded-full shrink-0 mt-0.5"
                      style={{ backgroundColor: event.color || 'rgb(var(--port-accent))' }}
                    />
                    <div className="min-w-0">
                      <div className="text-sm text-gray-300 truncate">{event.summary || event.title}</div>
                      <div className="text-xs text-gray-600">
                        {(event.isAllDay ?? event.allDay) ? 'All day' : `${formatTimeOfDay(event.startTime || event.start)} – ${formatTimeOfDay(event.endTime || event.end)}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </AmbientPanel>

          <AmbientPanel title="Goals" count={goals?.goals?.length}>
            {!goals?.goals?.length ? (
              <div className="text-gray-600 text-sm">No active goals</div>
            ) : (
              <div className="space-y-3">
                {goals.goals.slice(0, 5).map((goal) => (
                  <div key={goal.name}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-gray-400 truncate">{goal.icon} {goal.name}</span>
                      {goal.successRate !== null && (
                        <span className={`text-xs tabular-nums ${goalColorClass(goal.successRate)}`}>
                          {goal.successRate}%
                        </span>
                      )}
                    </div>
                    <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-1000"
                        style={{
                          width: `${Math.min(100, goal.successRate || 0)}%`,
                          backgroundColor: goalColor(goal.successRate)
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </AmbientPanel>

          <AmbientPanel title="Agent Activity">
            <div className="grid grid-cols-3 gap-3">
              <AmbientStat label="Running" value={today.running || 0} color={today.running > 0 ? 'rgb(var(--port-accent))' : null} />
              <AmbientStat label="Completed" value={today.completed || 0} color={today.completed > 0 ? 'rgb(var(--port-success))' : null} />
              <AmbientStat label="Failed" value={today.failed || 0} color={today.failed > 0 ? 'rgb(var(--port-error))' : null} />
            </div>
            {cosSummary?.status?.running && (
              <div className="mt-3 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-port-accent animate-pulse" />
                <span className="text-xs text-gray-500">CoS is active</span>
              </div>
            )}
          </AmbientPanel>
        </div>
        </div>
      </div>

      <div className={`px-6 py-3 flex justify-between items-center text-xs text-gray-700 transition-opacity duration-500 ${
        idle ? 'opacity-30' : 'opacity-100'
      }`}>
        <span>PortOS Ambient</span>
        <span className="flex items-center gap-2">
          <span className={`w-1.5 h-1.5 rounded-full ${socket.connected ? 'bg-port-success' : 'bg-gray-700'}`} />
          {socket.connected ? 'System Online' : 'Connecting...'}
        </span>
      </div>
    </div>
  );
}

function AmbientPanel({ title, count, children }) {
  return (
    <div className="bg-white/[0.02] border border-white/[0.04] rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wider">{title}</h3>
        {count != null && count > 0 && (
          <span className="text-xs text-gray-600 tabular-nums">{count}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function AmbientStat({ label, value, color }) {
  return (
    <div className="text-center">
      <div className="text-2xl font-light tabular-nums" style={{ color: color || '#6b7280' }}>
        {value}
      </div>
      <div className="text-[10px] text-gray-700 uppercase tracking-wider">{label}</div>
    </div>
  );
}
