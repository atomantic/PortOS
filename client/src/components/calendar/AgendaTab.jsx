import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Search, MapPin, Users, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../services/api';
import socket from '../../services/socket';
import EventDetail from './EventDetail';

const RSVP_STYLES = {
  accepted: 'bg-port-success/20 text-port-success',
  declined: 'bg-port-error/20 text-port-error',
  tentative: 'bg-port-warning/20 text-port-warning',
  none: 'bg-gray-700 text-gray-400'
};

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatDayHeader(dateStr) {
  const date = new Date(dateStr);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
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
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const fetchEvents = useCallback(async () => {
    const params = {};
    if (accountFilter) params.accountId = accountFilter;
    if (search) params.search = search;
    const data = await api.getCalendarEvents(params).catch(() => ({ events: [] }));
    setEvents(data?.events || []);
    setLoading(false);
  }, [accountFilter, search]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    const onSyncCompleted = () => {
      fetchEvents();
    };
    socket.on('calendar:sync:completed', onSyncCompleted);
    return () => {
      socket.off('calendar:sync:completed', onSyncCompleted);
    };
  }, [fetchEvents]);

  const handleSync = async () => {
    setSyncing(true);
    const enabledAccounts = accounts.filter(a => a.enabled);
    await Promise.allSettled(enabledAccounts.map(a => api.syncCalendarAccount(a.id)));
    setSyncing(false);
    toast.success('Calendar sync started');
  };

  const grouped = groupEventsByDay(events);

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search events..."
            className="w-full pl-9 pr-3 py-2 bg-port-card border border-port-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
          />
        </div>
        {accounts.length > 1 && (
          <select
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
          disabled={syncing || accounts.filter(a => a.enabled).length === 0}
          className="flex items-center gap-2 px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          Sync
        </button>
      </div>

      {/* Event list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw size={24} className="text-port-accent animate-spin" />
        </div>
      ) : grouped.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          <Clock size={48} className="mx-auto mb-4 opacity-50" />
          <p>No upcoming events</p>
          <p className="text-sm mt-1">Sync your calendar accounts to see events here</p>
        </div>
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
                    onClick={() => setSelectedEvent(event)}
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

      {/* Event detail slide-out */}
      {selectedEvent && (
        <EventDetail event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}
