import { useState, useRef } from 'react';
import { RefreshCw, Search, MapPin, Users, Clock } from 'lucide-react';
import {
  getCalendarEvents,
  syncCalendarAccount,
  apiSyncGoogleCalendar,
  mcpSyncGoogleCalendar,
} from '../../services/apiCalendar.js';
import { useSocketResource } from '../../hooks/useSocketResource';
import { useAccountSyncStatus } from '../../hooks/useAccountSyncStatus';
import EventDetail from './EventDetail';
import { formatCount, formatTimeOfDay as formatTime, formatWeekdayDate, localDateKey } from '../../utils/formatters';
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

const CALENDAR_EVENTS = ['calendar:changed'];
const EMPTY_EVENTS = [];
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200; // server cap per request

const dedupeEvents = list => [...new Map(list.map(event => [`${event.accountId}:${event.id}`, event])).values()];

export default function AgendaTab({ accounts }) {
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const loadedCount = useRef(0);

  const readPage = (offset, limit) => {
    const params = { startDate: new Date(`${fromDate}T00:00:00`).toISOString(), limit, offset };
    if (accountFilter) params.accountId = accountFilter;
    if (search) params.search = search;
    // The API owns the error toast; retain loaded pages and offer a retry.
    return getCalendarEvents(params);
  };

  // A first read loads one page; reconciliation (events, reconnect, retry)
  // re-reads as many events as are already shown so "Load more" progress survives.
  const { data, loading, error, refetch: fetchEvents, updateData } = useSocketResource(async ({ reconcile, events: invalidations }) => {
    const want = reconcile || invalidations.length ? Math.max(PAGE_SIZE, loadedCount.current) : PAGE_SIZE;
    const loaded = [];
    let total = 0;
    while (loaded.length < want) {
      const page = await readPage(loaded.length, Math.min(want - loaded.length, MAX_PAGE_SIZE));
      const batch = page?.events || [];
      total = page?.total ?? batch.length;
      loaded.push(...batch);
      if (batch.length === 0 || loaded.length >= total) break;
    }
    return { events: dedupeEvents(loaded), total };
  }, { events: CALENDAR_EVENTS, resourceKey: `${fromDate}|${accountFilter}|${search}` });
  const events = data?.events ?? EMPTY_EVENTS;
  const total = data?.total ?? 0;
  loadedCount.current = events.length;
  const failed = error != null || moreFailed;

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const page = await readPage(events.length, PAGE_SIZE).catch(() => null);
    if (page) {
      const batch = page.events || [];
      updateData(previous => ({ events: dedupeEvents([...previous.events, ...batch]), total: page.total ?? previous.total }));
    } else setMoreFailed(true);
    setLoadingMore(false);
  };
  const retry = () => (events.length > 0 && !error ? loadMore() : fetchEvents());

  const { sync } = useAccountSyncStatus({
    eventPrefix: 'calendar',
    label: 'Calendar sync',
    successText: ({ newEvents }) => `Calendar sync complete: ${newEvents ?? 0} events`,
    // A finished sync starts the list over from the first page.
    onRefresh: () => { loadedCount.current = 0; return fetchEvents(); },
    getAccountName: accountId => accounts.find(account => account.id === accountId)?.name,
    isStandaloneCompletion: ({ calendarId }) => Boolean(calendarId),
  });
  const batchPending = useRef(false);
  const enabledAccounts = accounts.filter(a => a.enabled);

  const handleSync = async () => {
    if (batchPending.current) return;
    batchPending.current = true;
    setSyncing(true);
    await Promise.allSettled(enabledAccounts.map(account => sync(account.id, () => {
      if (account.type !== 'google-calendar') return syncCalendarAccount(account.id, { silent: true });
      return account.syncMethod === 'google-api'
        ? apiSyncGoogleCalendar(account.id, { silent: true })
        : mcpSyncGoogleCalendar(account.id, { silent: true });
    })));
    batchPending.current = false;
    setSyncing(false);
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
          <button type="button" onClick={retry} className="min-h-[44px] rounded border border-port-border px-3 py-2 text-port-accent hover:bg-port-border">Retry</button>
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
            actionTo="/calendar/config"
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
          <p role="status" className="text-sm text-gray-400">{formatCount(events.length)} of {formatCount(total)} events loaded</p>
          {events.length < total && (
            <button
              onClick={loadMore}
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
