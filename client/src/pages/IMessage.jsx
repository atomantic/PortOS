import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  MessageSquare, RefreshCw, Search, Trash2, Ban, ChevronLeft,
  Loader2, ExternalLink, ShieldOff, Settings, CalendarClock, Users,
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import BrailleSpinner from '../components/BrailleSpinner';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import { formatClockTime, timeAgo } from '../utils/formatters';

// Comms → iMessage (#2413). Browse / manage PortOS-side activity ingested from
// macOS chat.db. Deletes and blocklists never write Apple's Messages database.

function formatWhen(iso) {
  if (!iso) return '—';
  try {
    return timeAgo(new Date(iso));
  } catch {
    return '—';
  }
}

function ConfirmBar({ message, confirmLabel, onConfirm, onCancel, danger }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-sm text-gray-200">
      <span className="flex-1 min-w-[12rem]">{message}</span>
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-port-border bg-port-bg px-3 py-1.5 text-xs hover:border-port-accent"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        className={`rounded px-3 py-1.5 text-xs font-medium ${
          danger
            ? 'bg-port-error/20 text-port-error hover:bg-port-error/30'
            : 'bg-port-accent/20 text-port-accent hover:bg-port-accent/30'
        }`}
      >
        {confirmLabel}
      </button>
    </div>
  );
}

function ConversationList({ conversations, selectedKey, onSelect, query, onQueryChange, loading }) {
  return (
    <div className="flex h-full min-h-0 flex-col border border-port-border bg-port-card rounded-lg overflow-hidden">
      <div className="border-b border-port-border p-2">
        <label htmlFor="imessage-search" className="sr-only">Search conversations</label>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            id="imessage-search"
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search title, handle, summary…"
            className="w-full rounded border border-port-border bg-port-bg py-2 pl-8 pr-3 text-sm text-white placeholder:text-gray-600 outline-none focus:border-port-accent"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="py-10 text-center text-gray-500 text-sm">Loading…</div>
        ) : conversations.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-gray-500">
            No conversations yet.
            <div className="mt-1 text-xs text-gray-600">
              Run a sync from Settings → iMessage, then refresh.
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-port-border">
            {conversations.map((c) => {
              const active = c.chatKey === selectedKey;
              return (
                <li key={c.chatKey || c.chatGuid || c.title}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.chatKey)}
                    className={`w-full text-left px-3 py-2.5 transition-colors ${
                      active ? 'bg-port-accent/15' : 'hover:bg-port-bg/80'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-sm text-gray-100">{c.title}</span>
                          {c.blocked && (
                            <span className="shrink-0 rounded bg-port-error/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-port-error">
                              Blocked
                            </span>
                          )}
                        </div>
                        {c.lastSummary && (
                          <div className="mt-0.5 truncate text-xs text-gray-500">{c.lastSummary}</div>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[10px] text-gray-500">{formatWhen(c.lastAt)}</div>
                        <div className="text-[10px] text-gray-600">{c.eventCount}</div>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ConversationDetail({
  chatKey,
  conversation,
  events,
  loading,
  timezone,
  onBack,
  onPurged,
  onEventDeleted,
  onBlocked,
}) {
  const [confirm, setConfirm] = useState(null); // 'purge' | 'block-purge' | null
  const [busy, setBusy] = useState(false);

  const handle = conversation?.handle;

  const runPurge = async () => {
    setBusy(true);
    const result = await api.purgeImessageConversation(chatKey, { silent: true }).catch(() => null);
    setBusy(false);
    setConfirm(null);
    if (!result) {
      toast.error('Failed to purge conversation');
      return;
    }
    toast.success(`Removed ${result.deleted} event(s) from PortOS`);
    onPurged?.(chatKey);
  };

  const runBlock = async ({ purgeExisting }) => {
    if (!handle) {
      toast.error('No handle to block on this conversation');
      setConfirm(null);
      return;
    }
    setBusy(true);
    const result = await api.addImessageBlocklist(handle, { purgeExisting, silent: true }).catch(() => null);
    setBusy(false);
    setConfirm(null);
    if (!result) {
      toast.error('Failed to update blocklist');
      return;
    }
    const purged = result.purged || 0;
    toast.success(
      purged > 0
        ? `Blocked ${handle} — removed ${purged} PortOS event(s)`
        : `Blocked ${handle} — future syncs will skip it`,
    );
    onBlocked?.(chatKey, { purged });
  };

  const deleteEvent = async (id) => {
    const result = await api.deleteImessageEvent(id, { silent: true }).catch(() => null);
    if (!result) {
      toast.error('Failed to delete event');
      return;
    }
    if (result.deleted > 0) {
      toast.success('Event removed from PortOS');
      onEventDeleted?.(id);
    } else {
      toast.error('Event not found');
    }
  };

  if (!chatKey) {
    return (
      <div className="flex h-full min-h-[16rem] items-center justify-center rounded-lg border border-dashed border-port-border text-sm text-gray-500">
        Select a conversation to inspect summaries and manage PortOS copies.
      </div>
    );
  }

  const lastDay = conversation?.lastAt
    ? new Date(conversation.lastAt).toISOString().slice(0, 10)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border border-port-border bg-port-card overflow-hidden">
      <div className="border-b border-port-border p-3 space-y-2">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onBack}
            className="md:hidden rounded border border-port-border p-1.5 hover:border-port-accent"
            aria-label="Back to conversations"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-white">
              {conversation?.title || 'Conversation'}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
              {handle && <span className="font-mono">{handle}</span>}
              {conversation?.eventCount != null && (
                <span>{conversation.eventCount} event(s)</span>
              )}
              {conversation?.blocked && (
                <span className="rounded bg-port-error/15 px-1.5 py-0.5 text-[10px] uppercase text-port-error">
                  Blocked
                </span>
              )}
            </div>
          </div>
        </div>

        <p className="text-[11px] text-gray-600">
          Deletes remove PortOS activity only — Apple Messages is never modified.
        </p>

        {confirm === 'purge' && (
          <ConfirmBar
            message="Purge all PortOS events for this conversation? Messages.app is unchanged."
            confirmLabel={busy ? 'Purging…' : 'Purge from PortOS'}
            danger
            onCancel={() => setConfirm(null)}
            onConfirm={runPurge}
          />
        )}
        {confirm === 'block-purge' && (
          <ConfirmBar
            message={`Block ${handle || 'this handle'} and remove matching PortOS events?`}
            confirmLabel={busy ? 'Working…' : 'Block + purge'}
            danger
            onCancel={() => setConfirm(null)}
            onConfirm={() => runBlock({ purgeExisting: true })}
          />
        )}

        {!confirm && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setConfirm('purge')}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-bg px-2.5 py-1.5 text-xs text-gray-200 hover:border-port-error hover:text-port-error disabled:opacity-40"
            >
              <Trash2 size={12} />
              Purge from PortOS
            </button>
            {handle && !conversation?.blocked && (
              <>
                <button
                  type="button"
                  onClick={() => runBlock({ purgeExisting: false })}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-bg px-2.5 py-1.5 text-xs text-gray-200 hover:border-port-accent disabled:opacity-40"
                >
                  <Ban size={12} />
                  Block handle
                </button>
                <button
                  type="button"
                  onClick={() => setConfirm('block-purge')}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-bg px-2.5 py-1.5 text-xs text-gray-200 hover:border-port-error hover:text-port-error disabled:opacity-40"
                >
                  <Ban size={12} />
                  Block + purge
                </button>
              </>
            )}
            {lastDay && (
              <Link
                to={`/timeline/${lastDay}`}
                className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-bg px-2.5 py-1.5 text-xs text-gray-200 hover:border-port-accent"
              >
                <CalendarClock size={12} />
                Timeline day
                <ExternalLink size={10} className="opacity-60" />
              </Link>
            )}
            <Link
              to="/tribe"
              className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-bg px-2.5 py-1.5 text-xs text-gray-200 hover:border-port-accent"
            >
              <Users size={12} />
              Tribe phones
            </Link>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {loading ? (
          <div className="py-10 text-center text-gray-500 text-sm">Loading events…</div>
        ) : events.length === 0 ? (
          <div className="py-10 text-center text-sm text-gray-500">No events in PortOS for this chat.</div>
        ) : (
          events.map((ev) => (
            <div
              key={ev.id}
              className="flex gap-2 rounded border border-port-border bg-port-bg/50 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
                  <span className="font-mono">
                    {formatClockTime(new Date(ev.happenedAt), timezone ? { timeZone: timezone } : undefined)}
                  </span>
                  <span className="uppercase tracking-wide">
                    {ev.kind === 'message.sent' ? 'Sent' : ev.kind === 'message.received' ? 'Received' : ev.kind}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-gray-200 break-words">
                  {ev.summary || <span className="text-gray-600 italic">(no summary)</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => deleteEvent(ev.id)}
                className="shrink-0 self-start rounded p-1.5 text-gray-500 hover:bg-port-error/15 hover:text-port-error"
                aria-label="Delete event from PortOS"
                title="Delete from PortOS only"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function IMessage() {
  const { chatKey: chatKeyParam } = useParams();
  const navigate = useNavigate();
  const selectedKey = chatKeyParam || null;

  const [stats, setStats] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const loadList = useCallback(async () => {
    setListLoading(true);
    const [statsRes, convRes] = await Promise.all([
      api.getImessageStats({ silent: true }).catch(() => null),
      api.getImessageConversations({ q: debouncedQ || undefined, silent: true }).catch(() => null),
    ]);
    setStats(statsRes);
    setConversations(convRes?.conversations || []);
    setListLoading(false);
  }, [debouncedQ]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedKey) {
      setEvents([]);
      return undefined;
    }
    let active = true;
    setEventsLoading(true);
    api.getImessageConversationEvents(selectedKey, { limit: 200, silent: true })
      .then((res) => {
        if (active) setEvents(res?.events || []);
      })
      .catch(() => {
        if (active) {
          setEvents([]);
          toast.error('Failed to load conversation');
        }
      })
      .finally(() => {
        if (active) setEventsLoading(false);
      });
    return () => { active = false; };
  }, [selectedKey]);

  const selectedConversation = useMemo(
    () => conversations.find((c) => c.chatKey === selectedKey) || null,
    [conversations, selectedKey],
  );

  const select = (key) => {
    navigate(key ? `/imessage/${encodeURIComponent(key)}` : '/imessage');
  };

  const handleSync = async () => {
    setSyncing(true);
    const result = await api.syncImessage({ silent: true }).catch(() => ({ ok: false, error: 'Sync failed' }));
    setSyncing(false);
    if (result?.ok) {
      toast.success(
        `Synced: ${result.recorded} event(s)`
          + (result.blockedSkipped ? `, ${result.blockedSkipped} blocked` : '')
          + (result.hasMore ? ' — more history remains' : ''),
      );
      await loadList();
    } else {
      toast.error(result?.fullDiskAccessRequired ? 'Full Disk Access required' : (result?.error || 'Sync failed'));
    }
  };

  const onPurged = (key) => {
    setConversations((prev) => prev.filter((c) => c.chatKey !== key));
    setEvents([]);
    navigate('/imessage');
    loadList();
  };

  const onEventDeleted = (id) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
    setConversations((prev) => prev.map((c) => (
      c.chatKey === selectedKey
        ? { ...c, eventCount: Math.max(0, (c.eventCount || 1) - 1) }
        : c
    )));
  };

  const onBlocked = (key, { purged }) => {
    if (purged > 0) {
      setConversations((prev) => prev.filter((c) => c.chatKey !== key));
      setEvents([]);
      navigate('/imessage');
    } else {
      setConversations((prev) => prev.map((c) => (
        c.chatKey === key ? { ...c, blocked: true } : c
      )));
    }
    loadList();
  };

  const hasMore = stats?.sync?.state?.lastResult?.hasMore;
  const showDetailMobile = !!selectedKey;

  if (listLoading && conversations.length === 0 && !stats) {
    return (
      <div className="flex h-full items-center justify-center">
        <BrailleSpinner text="Loading iMessage" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 md:p-6">
      <PageHeader
        icon={MessageSquare}
        title="iMessage"
        subtitle="Browse and manage PortOS copies of your local Messages activity. Full bodies stay in Apple's chat.db — deletes never write back."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/settings/imessage"
              className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-card px-3 py-1.5 text-xs text-gray-300 hover:border-port-accent"
            >
              <Settings size={12} />
              Settings
            </Link>
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-card px-3 py-1.5 text-xs text-gray-200 hover:border-port-accent disabled:opacity-40"
            >
              {syncing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {hasMore ? 'Sync more history' : 'Sync now'}
            </button>
          </div>
        )}
      />

      <div className="flex flex-wrap gap-2 text-xs text-gray-400">
        <span className="rounded border border-port-border bg-port-card px-2 py-1">
          {stats?.eventCount ?? 0} events
        </span>
        <span className="rounded border border-port-border bg-port-card px-2 py-1">
          {stats?.conversationCount ?? 0} conversations
        </span>
        <span className="rounded border border-port-border bg-port-card px-2 py-1">
          {stats?.blockedCount ?? 0} blocked
        </span>
        {stats?.earliestAt && (
          <span className="rounded border border-port-border bg-port-card px-2 py-1">
            {new Date(stats.earliestAt).toLocaleDateString()} → {stats.latestAt ? new Date(stats.latestAt).toLocaleDateString() : '—'}
          </span>
        )}
        {hasMore && (
          <span className="rounded border border-port-warning/40 bg-port-warning/10 px-2 py-1 text-port-warning">
            More history remains — run Sync more
          </span>
        )}
      </div>

      {stats?.eventCount === 0 && (
        <div className="rounded border border-dashed border-port-border px-4 py-3 text-sm text-gray-500">
          Nothing ingested yet. Grant Full Disk Access if needed, then use{' '}
          <Link to="/settings/imessage" className="text-port-accent hover:underline">Settings → iMessage</Link>
          {' '}or <strong className="text-gray-400">Sync now</strong> above. Data also appears on the{' '}
          <Link to="/timeline" className="text-port-accent hover:underline">Timeline</Link>
          {' '}day view (navigate to the date range of your messages).
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(16rem,22rem)_1fr]">
        <div className={`min-h-0 ${showDetailMobile ? 'hidden md:block' : 'block'} h-[min(70vh,40rem)] md:h-auto`}>
          <ConversationList
            conversations={conversations}
            selectedKey={selectedKey}
            onSelect={select}
            query={query}
            onQueryChange={setQuery}
            loading={listLoading}
          />
        </div>
        <div className={`min-h-0 ${showDetailMobile ? 'block' : 'hidden md:block'} h-[min(70vh,40rem)] md:h-auto`}>
          <ConversationDetail
            chatKey={selectedKey}
            conversation={selectedConversation}
            events={events}
            loading={eventsLoading}
            timezone={undefined}
            onBack={() => select(null)}
            onPurged={onPurged}
            onEventDeleted={onEventDeleted}
            onBlocked={onBlocked}
          />
        </div>
      </div>

      {(stats?.blockedCount > 0) && (
        <BlocklistPanel onChanged={loadList} />
      )}
    </div>
  );
}

function BlocklistPanel({ onChanged }) {
  const [handles, setHandles] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getImessageBlocklist({ silent: true })
      .then((res) => setHandles(res?.handles || []))
      .catch(() => setHandles([]))
      .finally(() => setLoading(false));
  }, []);

  const unblock = async (handle) => {
    const res = await api.removeImessageBlocklist(handle, { silent: true }).catch(() => null);
    if (!res) {
      toast.error('Failed to unblock');
      return;
    }
    setHandles(res.handles || []);
    toast.success(`Unblocked ${handle}`);
    onChanged?.();
  };

  if (loading || handles.length === 0) return null;

  return (
    <div className="rounded-lg border border-port-border bg-port-card p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        <ShieldOff size={12} />
        Blocked handles
      </div>
      <ul className="flex flex-wrap gap-2">
        {handles.map((h) => (
          <li key={h} className="inline-flex items-center gap-1.5 rounded border border-port-border bg-port-bg px-2 py-1 text-xs text-gray-300">
            <span className="font-mono">{h}</span>
            <button
              type="button"
              onClick={() => unblock(h)}
              className="text-gray-500 hover:text-port-accent"
              aria-label={`Unblock ${h}`}
            >
              Unblock
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-gray-600">
        Unblocking does not re-import past messages (the sync cursor only moves forward).
      </p>
    </div>
  );
}
