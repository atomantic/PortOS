import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Search, MapPin, Users, Clock } from 'lucide-react';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import socket from '../../services/socket';
import EventDetail from './EventDetail';
import { formatTimeOfDay as formatTime, formatWeekdayDate, localDateKey } from '../../utils/formatters';
import BrailleSpinner from '../BrailleSpinner';
import EmptyState from '../EmptyState';
import useUrlParams from '../../hooks/useUrlParams';

const RSVP_STYLES = {
  accepted: 'bg-port-success/20 text-port-success',
  declined: 'bg-port-error/20 text-port-error',
  tentative: 'bg-port-warning/20 text-port-warning',
  none: 'bg-gray-700 text-gray-400'
};

function formatDayHeader(dateStr) {
  const date = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return formatWeekdayDate(date);
}

function groupEventsByDay(events) {
  const groups = {};
  for (const event of events) {
    const dayKey = new Date(event.startTime).toDateString();
    if (!groups[dayKey]) groups[dayKey] = [];
    groups[dayKey].push(event);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => new Date(a) - new Date(b))
    .map(([dayKey, dayEvents]) => ({
      date: dayKey,
      events: dayEvents.sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
    }));
}

export default function AgendaTab({ accounts }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [accountFilter, setAccountFilter] = useState('');
  const [searchParams, updateParams] = useUrlParams();
  const [syncing, setSyncing] = useState(false);

  const today = localDateKey();
  const requestedDate = searchParams.get('from');
  const parsedDate = new Date(`${requestedDate}T00:00:00`);
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
    && Number.isFinite(parsedDate.getTime()) && localDateKey(parsedDate) === requestedDate
    ? requestedDate : today;
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestGeneration = useRef(0);
  const nextOffset = useRef(0);
  const pending = useRef(false);

  const fetchEvents = useCallback(async (append = false) => {
    if (append && pending.current) return;
    const generation = ++requestGeneration.current;
    pending.current = true;
    setFailed(false);
    setLoadingMore(append);
    if (!append) {
      nextOffset.current = 0;
      setEvents([]);
      setTotal(0);
      setLoading(true);
    }
    const offset = nextOffset.current;
    const params = {
      startDate: new Date(`${fromDate}T00:00:00`).toISOString(),
      limit: 50,
      offset,
    };
    if (accountFilter) params.accountId = accountFilter;
    if (search) params.search = search;
    // The API owns the error toast; retain loaded pages and offer a retry.
    const data = await api.getCalendarEvents(params).catch(() => null);
    if (generation !== requestGeneration.current) return;
    if (data) {
      const page = data.events || [];
      nextOffset.current = offset + page.length;
      setEvents(previous => {
        const combined = append ? [...previous, ...page] : page;
        return [...new Map(combined.map(event => [`${event.accountId}:${event.id}`, event])).values()];
      });
      setTotal(data.total ?? page.length);
    } else {
      setFailed(true);
    }
    pending.current = false;
    setLoading(false);
    setLoadingMore(false);
  }, [accountFilter, search, fromDate]);

  useEffect(() => {
    fetchEvents();
    const onSyncCompleted = () => fetchEvents();
    socket.on('calendar:sync:completed', onSyncCompleted);
    return () => {
      ++requestGeneration.current;
      pending.current = false;
      socket.off('calendar:sync:completed', onSyncCompleted);
    };
  }, [fetchEvents]);

  const enabledAccounts = accounts.filter(a => a.enabled);

  const handleSync = async () => {
    setSyncing(true);
    await Promise.allSettled(enabledAccounts.map(a => api.syncCalendarAccount(a.id)));
    setSyncing(false);
    toast.success('Calendar sync started');
  };

  const grouped = groupEventsByDay(events);
  const selectedEventKey = searchParams.get('event');
  const selectedEvent = events.find((event) => `${event.accountId}:${event.id}` === selectedEventKey) || null;
  const hasActiveFilter = Boolean(search || accountFilter);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="agenda-from" className="text-sm text-gray-400">From date</label>
          <input
            id="agenda-from"
            type="date"
            value={fromDate}
            onChange={e => updateParams({ from: e.target.value || null })}
            className="min-w-0 px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-white"
          />
          <button
            onClick={() => updateParams({ from: null })}
            className="px-3 py-2 text-port-accent rounded-lg text-sm hover:bg-port-accent/10"
          >
            Today
          </button>
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search events..."
            aria-label="Search events"
            className="w-full pl-9 pr-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
          />
        </div>
        {accounts.length > 1 && (
          <select
            aria-label="Filter by account"
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
            className="px-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-white focus:outline-none focus:border-port-accent"
          >
            <option value="">All accounts</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        )}
        <button
          onClick={handleSync}
          disabled={syncing || enabledAccounts.length === 0}
          className="flex items-center gap-2 px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          Sync
        </button>
      </div>

      {failed && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-port-error">
          Could not load events.
          <button onClick={() => fetchEvents(nextOffset.current > 0)} className="underline">Retry</button>
        </div>
      )}

      {/* Event list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <BrailleSpinner text="Loading" />
        </div>
      ) : failed && grouped.length === 0 ? null : grouped.length === 0 ? (
        hasActiveFilter ? (
          <EmptyState
            icon={Clock}
            title="No matching events"
            message="Try clearing your search or account filter."
            actionLabel="Clear filters"
            onAction={() => {
              setSearch('');
              setAccountFilter('');
            }}
          />
        ) : enabledAccounts.length === 0 ? (
          <EmptyState
            icon={Clock}
            title="No calendar connected"
            message="Connect a calendar account to see upcoming events."
            actionTo="/calendar/sync"
            actionLabel="Connect a calendar"
          />
        ) : (
          <EmptyState
            icon={Clock}
            title="No upcoming events"
            message="Sync now to pull upcoming events"
            onAction={handleSync}
            actionLabel="Sync now"
            actionDisabled={syncing}
          />
        )
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.date}>
              <h3 className="text-sm font-semibold text-gray-400 mb-2 sticky top-0 bg-port-bg py-1">
                {formatDayHeader(group.date)}
              </h3>
              <div className="space-y-1">
                {group.events.map((event) => (
                  <button
                    key={`${event.accountId}-${event.id}`}
                    onClick={() => updateParams({ event: `${event.accountId}:${event.id}` })}
                    className="w-full text-left flex items-center gap-3 p-3 bg-port-card rounded-lg border border-port-border hover:border-port-accent/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{event.title}</span>
                        {event.isAllDay && (
                          <span className="px-1.5 py-0.5 text-[10px] font-medium bg-port-accent/20 text-port-accent rounded">
                            All day
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                        {!event.isAllDay && (
                          <span className="flex items-center gap-1">
                            <Clock size={12} />
                            {formatTime(event.startTime)} - {formatTime(event.endTime)}
                          </span>
                        )}
                        {event.location && (
                          <span className="flex items-center gap-1 truncate">
                            <MapPin size={12} />
                            {event.location}
                          </span>
                        )}
                        {event.attendees?.length > 0 && (
                          <span className="flex items-center gap-1">
                            <Users size={12} />
                            {event.attendees.length}
                          </span>
                        )}
                      </div>
                    </div>
                    {event.myStatus && event.myStatus !== 'none' && event.myStatus !== 'unknown' && (
                      <span className={`px-2 py-0.5 text-[10px] font-medium rounded ${RSVP_STYLES[event.myStatus] || RSVP_STYLES.none}`}>
                        {event.myStatus}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && events.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-3">
          <p role="status" className="text-sm text-gray-400">{events.length} of {total} events loaded</p>
          {nextOffset.current < total && (
            <button
              onClick={() => fetchEvents(true)}
              disabled={loadingMore}
              className="px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 disabled:opacity-50"
            >
              {loadingMore ? 'Loading more…' : 'Load more'}
            </button>
          )}
        </div>
      )}

      {/* Event detail slide-out */}
      {selectedEvent && (
        <EventDetail event={selectedEvent} onClose={() => updateParams({ event: null })} />
      )}
    </div>
  );
}
