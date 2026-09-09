import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  Archive, BellOff, Clock, Filter, Inbox, Loader2, Mail, MoreHorizontal,
  PenSquare, Plus, RefreshCw, Search, Settings, TrendingDown,
} from 'lucide-react';
import NetworkLogo, { networkLabel } from './BeeperNetworkLogo';
import BeeperThread from './BeeperThread';
import ConnectionStatusDot from '../../ui/ConnectionStatusDot';
import toast from '../../ui/Toast';
import useMounted from '../../../hooks/useMounted';
import useBeeperOutbox from '../../../hooks/useBeeperOutbox';
import { messagePreviewText } from '../../../lib/beeperMessageBody';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../../lib/safeStorage';
import { formatClockTime } from '../../../utils/formatters';
import * as api from '../../../services/api';

/**
 * The Beeper chat surface (#35): rail, pinned grid, conversation rows, thread
 * and composer, ported from the #9 prototype onto the real mirror.
 *
 * #9's resolution is that **the reference interface IS the design** — port
 * Beeper Desktop, mark the deltas, do not redesign around it. The deltas:
 *
 *  - **Network badges appear on rows only when the list spans networks.**
 *    Inside a single-network scope the rail already states the network, so a
 *    per-row badge is noise and is dropped entirely. This is the one rule a
 *    from-scratch design would most likely have got wrong, in either direction.
 *  - **The rail is one entry per network the MIRROR holds**, never a hardcoded
 *    roster and never the reference's user-curated saved scopes at mixed grain
 *    (a Discord-DMs chip beside a single-server chip). Those are deferred.
 *  - **`Archive` and `Low priority` are wired**, because `isArchived` and
 *    `isLowPriority` are real fields on every chat row. `Requests`, `Later`,
 *    `add scope` and the overflow menu render INERT with a tooltip saying so —
 *    an inert control that looks live is worse than an absent one.
 *  - **The pinned grid is Beeper's own `isPinned`, mirrored.** PortOS never
 *    stores a pin of its own; a second source of truth for it is the whole
 *    thing #27 was designed to avoid.
 *
 * Selection lives in the URL (`/messages/beeper/:conversationId`), as does the
 * scope and the unread-only filter, so a conversation is shareable, bookmarkable
 * and reachable from ⌘K and voice — and a cold load on a deep link opens the
 * thread directly rather than the index.
 *
 * Realtime is invalidation-driven (#33): a frame never carries rows, so the
 * surface refetches from the PortOS mirror. Every fetch is generation-guarded,
 * so a response that lands after the user has moved on is dropped rather than
 * rendered over the newer one.
 */

// Fixed system scopes, in the reference's own order. `live: false` entries
// render disabled with a tooltip rather than being omitted, so the deferral is
// visible instead of silently missing (#9).
const SYSTEM_SCOPES = [
  { id: 'inbox', label: 'Inbox', icon: Inbox, live: true },
  { id: 'archive', label: 'Archive', icon: Archive, live: true },
  { id: 'requests', label: 'Requests', icon: Mail, live: false },
  { id: 'low', label: 'Low priority', icon: TrendingDown, live: true },
  { id: 'later', label: 'Later', icon: Clock, live: false },
];

const LIVE_SYSTEM_SCOPES = new Set(SYSTEM_SCOPES.filter((scope) => scope.live).map((scope) => scope.id));
const NETWORK_SCOPE_PREFIX = 'net:';
const PINNED_GRID_CAP = 6;
const DRAFTS_STORAGE_KEY = 'portos-beeper-drafts';
// One coalescing window for a burst of invalidation frames. A busy account can
// emit several per second; refetching per frame would hammer the mirror for a
// list that has not finished rendering the previous answer.
const INVALIDATION_DEBOUNCE_MS = 350;
// A CEILING on how long the debounce above may keep resetting itself, anchored
// to the FIRST frame of the current window rather than the last. Without this
// a sustained stream (the "several per second" case the comment above already
// warns about) never goes quiet for 350ms, so the coalescing timer restarts
// forever and the list/thread never refresh at all (finding PERF-10). 2s is
// six debounce windows: loose enough that an ordinary burst still coalesces
// into one refetch, tight enough that a busy account's view is never more
// than two seconds stale.
const INVALIDATION_MAX_WAIT_MS = 2000;
// #81: how long a conversation with no mirrored message is still read as
// "the mirror hasn't caught up yet" rather than "genuinely has no history".
// The mirror sweep (`beeperSync.js`) now retries an empty first page exactly
// once and settles within a sweep pass or two (minutes, not hours), so this
// is deliberately generous rather than tuned to that — it exists to cover a
// slow initial sweep across many accounts/chats, not to model the retry
// timing precisely.
const RECENT_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The filter set one scope means. Absent keys are absent FILTERS, not `false`. */
function filtersForScope(scope, unreadOnly) {
  const base = unreadOnly ? { unreadOnly: true } : {};
  if (scope === 'archive') return { ...base, archived: true };
  if (scope === 'low') return { ...base, lowPriority: true };
  if (typeof scope === 'string' && scope.startsWith(NETWORK_SCOPE_PREFIX)) {
    return { ...base, network: scope.slice(NETWORK_SCOPE_PREFIX.length), archived: false };
  }
  return { ...base, archived: false, lowPriority: false };
}

const scopeNetwork = (scope) => (
  typeof scope === 'string' && scope.startsWith(NETWORK_SCOPE_PREFIX)
    ? scope.slice(NETWORK_SCOPE_PREFIX.length)
    : null
);

const rowTime = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
};

// #81: `lastActivity` is Beeper's own chat-level watermark, mirrored
// regardless of whether any message has been mirrored yet (`beeperSync.js`'s
// `normalizeChatRow`) — so a row can carry a recent one while `lastMessage`
// is still `null`. That combination is what distinguishes "still syncing"
// from "this chat has no history", and is the ONLY thing that does: nothing
// else in the row shape says whether the mirror has caught up.
const isRecentActivity = (iso) => {
  if (!iso) return false;
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) && Date.now() - ts < RECENT_ACTIVITY_WINDOW_MS;
};

const initials = (name) => String(name || '?')
  .replace(/^[#+@]/, '')
  .split(/\s+/)
  .slice(0, 2)
  .map((word) => word[0])
  .filter(Boolean)
  .join('')
  .toUpperCase() || '?';

function Avatar({ name, size = 40 }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-port-border font-medium text-gray-300"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
      aria-hidden="true"
    >
      {initials(name)}
    </div>
  );
}

/**
 * The list header's sweep-visibility strip (#80): "Syncing… N of M accounts"
 * while a sweep runs, "Last synced HH:MM" once one has finished, and nothing
 * at all before the first sweep has ever run (a fresh install with no `sweep`
 * snapshot yet, or one whose `accountsTotal` is not known yet mid-sweep still
 * says "Syncing…" alone rather than "0 of null accounts").
 */
function SyncStrip({ sweep }) {
  if (!sweep) return null;
  if (sweep.running) {
    const total = Number.isFinite(sweep.accountsTotal) ? sweep.accountsTotal : null;
    const done = Number.isFinite(sweep.accountsDone) ? sweep.accountsDone : 0;
    return (
      <div className="flex shrink-0 items-center gap-1.5 border-b border-port-border/60 px-3 py-1.5 text-[11px] text-gray-400">
        <Loader2 size={11} className="animate-spin" />
        {total === null ? 'Syncing…' : `Syncing… ${done} of ${total} account${total === 1 ? '' : 's'}`}
      </div>
    );
  }
  if (!sweep.finishedAt) return null;
  return (
    <div className="shrink-0 border-b border-port-border/60 px-3 py-1.5 text-[11px] text-gray-500">
      Last synced {formatClockTime(sweep.finishedAt, { seconds: false })}
    </div>
  );
}

function InertControl({ icon: Icon, label, className }) {
  return (
    <button
      type="button"
      disabled
      aria-label={label}
      title={`${label} — not available yet`}
      className={`${className} cursor-not-allowed opacity-35`}
    >
      <Icon size={17} />
    </button>
  );
}

/* ------------------------------------------------------------------ rail -- */

function Rail({
  networks, scope, onScope, totalUnread, onOpenSettings,
}) {
  const item = 'relative flex size-11 shrink-0 items-center justify-center rounded-xl transition';
  return (
    <div className="flex w-full shrink-0 flex-row items-center gap-1 overflow-x-auto border-b border-port-border bg-port-bg/60 px-2 py-1.5 sm:w-[68px] sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:border-b-0 sm:border-r sm:px-0 sm:py-2">
      {SYSTEM_SCOPES.map((systemScope) => {
        const Icon = systemScope.icon;
        const active = scope === systemScope.id;
        if (!systemScope.live) {
          return <InertControl key={systemScope.id} icon={Icon} label={systemScope.label} className={`${item} text-gray-500`} />;
        }
        return (
          <button
            key={systemScope.id}
            type="button"
            title={systemScope.label}
            aria-label={systemScope.label}
            aria-pressed={active}
            onClick={() => onScope(systemScope.id)}
            className={`${item} ${active ? 'bg-port-card text-white' : 'text-gray-500 hover:text-white'}`}
          >
            <Icon size={19} />
            {systemScope.id === 'inbox' && totalUnread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 rounded-full bg-port-accent px-1 text-[9px] font-semibold text-port-bg">
                {totalUnread > 999 ? '999+' : totalUnread}
              </span>
            )}
          </button>
        );
      })}

      <div className="mx-1 h-7 w-px shrink-0 bg-port-border sm:mx-0 sm:my-1.5 sm:h-px sm:w-7" />

      {networks.map((entry) => {
        const id = `${NETWORK_SCOPE_PREFIX}${entry.network}`;
        const active = scope === id;
        const label = networkLabel(entry.network);
        return (
          <button
            key={entry.network}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => onScope(id)}
            className={`${item} ${active ? 'bg-port-card ring-2 ring-port-accent' : 'opacity-80 hover:opacity-100'}`}
          >
            <NetworkLogo network={entry.network} label={label} size={26} />
            {entry.unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-port-accent px-1 text-[9px] font-semibold text-port-bg">
                {entry.unreadCount > 99 ? '99+' : entry.unreadCount}
              </span>
            )}
          </button>
        );
      })}

      <div className="mx-1 h-7 w-px shrink-0 bg-port-border sm:mx-0 sm:my-1.5 sm:h-px sm:w-7" />
      <InertControl icon={Plus} label="Add scope" className={`${item} border border-dashed border-port-border text-gray-500`} />
      <InertControl icon={MoreHorizontal} label="More scope options" className={`${item} text-gray-500`} />

      <button
        type="button"
        onClick={onOpenSettings}
        title="Beeper settings and connection status"
        aria-label="Beeper settings"
        className={`${item} ml-auto text-gray-500 hover:text-white sm:ml-0 sm:mt-auto`}
      >
        <Settings size={18} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------ pinned grid -- */

function PinnedGrid({ conversations, unified, onSelect }) {
  if (conversations.length === 0) return null;
  return (
    <div className="grid shrink-0 grid-cols-3 gap-2 border-b border-port-border px-3 pb-3 pt-2">
      {conversations.map((conversation) => (
        <button
          key={conversation.id}
          type="button"
          onClick={() => onSelect(conversation.id)}
          className="relative flex flex-col items-center gap-1 pt-1"
        >
          <span className="relative">
            <Avatar name={conversation.title} size={48} />
            {conversation.unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 z-10 min-w-4 rounded-full bg-port-accent px-1 text-center text-[10px] font-semibold text-port-bg ring-2 ring-port-bg">
                {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
              </span>
            )}
            {unified && (
              <span data-testid="network-badge" className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-port-bg">
                <NetworkLogo network={conversation.network} size={16} />
              </span>
            )}
          </span>
          <span className="flex w-full items-center justify-center gap-0.5">
            <span className="truncate text-[11px] text-gray-400">{(conversation.title || '—').split(' ')[0]}</span>
            {conversation.isMuted && <BellOff size={9} className="shrink-0 text-gray-600" />}
          </span>
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- row -- */

function ConversationRow({ conversation, unified, selected, onSelect }) {
  const preview = conversation.lastMessage;
  // The same body the thread renders, flattened to one line: some networks
  // deliver HTML, and this row used to show the tags literally.
  //
  // #81: no mirrored message does not always mean "there is nothing to
  // mirror" — a chat whose first sweep came back empty is retried, and until
  // that lands the row used to look identical to a chat that is genuinely
  // history-less forever, sorting at the top (recency) while reading like a
  // stale placeholder. Beeper's Chat payload carries no preview/snippet text
  // of its own to show instead (only `beeperSync.js`'s own mirrored messages
  // do), so a recent `lastActivity` with no `lastMessage` reads as still
  // syncing; the honest copy is kept for everything else.
  const previewText = preview
    ? (preview.isUnsent ? 'Message unsent' : messagePreviewText(preview.body))
    : (isRecentActivity(conversation.lastActivity) ? 'Syncing…' : 'No messages mirrored yet');
  // The reference's leading state chip. Direction is the mirrored `isSender`,
  // never a comparison against the local user — there is nothing to compare
  // `senderId` against (#2).
  const outbound = preview?.isSender === true;
  return (
    <button
      type="button"
      onClick={() => onSelect(conversation.id)}
      aria-current={selected ? 'true' : undefined}
      className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-port-card ${selected ? 'bg-port-card' : ''}`}
    >
      <span className="relative shrink-0">
        <Avatar name={conversation.title} />
        {/* THE conditional rule from #9: badge only when the list spans networks. */}
        {unified && (
          <span data-testid="network-badge" className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-port-bg">
            <NetworkLogo network={conversation.network} size={15} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className={`truncate text-[13px] ${conversation.unreadCount > 0 ? 'font-semibold text-white' : 'text-gray-200'}`}>
            {conversation.title || 'Untitled conversation'}
          </span>
          {conversation.isMuted && <BellOff size={11} className="shrink-0 text-gray-600" />}
          <span className="ml-auto shrink-0 pl-1 text-[11px] text-gray-500">{rowTime(conversation.lastActivity)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1">
          {outbound && <span className="shrink-0 text-xs text-gray-500">You:</span>}
          <span className="min-w-0 flex-1 truncate text-xs text-gray-400">{previewText}</span>
          {conversation.unreadCount > 0 && (
            <span className="shrink-0 rounded-full bg-port-accent px-1.5 py-px text-[10px] font-semibold text-port-bg">
              {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- surface -- */

export default function BeeperChatSurface({
  conversationId = null, realtime = null, invalidationSeq = 0, invalidationFrames = null, breaker = null,
  sweep = null, tokenConfigured = false, onOpenSettings,
}) {
  const navigate = useNavigate();
  const mountedRef = useMounted();
  const [searchParams, setSearchParams] = useSearchParams();

  const scopeParam = searchParams.get('scope') || 'inbox';
  const unreadOnly = searchParams.get('unread') === '1';

  const [networks, setNetworks] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [listCursor, setListCursor] = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [conversation, setConversation] = useState(null);
  const [conversationMissing, setConversationMissing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [messageCursor, setMessageCursor] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [people, setPeople] = useState([]);
  const [linkingId, setLinkingId] = useState(null);
  const [writePending, setWritePending] = useState(false);
  const [purging, setPurging] = useState(false);

  // A PortOS-side draft buffer, keyed by conversation, so a half-written
  // message survives switching threads AND leaving the page. It is deliberately
  // NOT Beeper's own chat draft: that is a two-call clear-then-set dance on
  // PATCH, and syncing one before a send path exists would put half-written
  // text on the user's phone.
  const [drafts, setDrafts] = useState(() => safeReadJsonStorage(DRAFTS_STORAGE_KEY, {}) || {});

  // Generation guards. Every async response checks the generation it was issued
  // under and drops itself if the user has moved on — the stale-response rule
  // from the socket-UI conventions, which matters here because an invalidation
  // burst can put several list fetches in flight at once.
  const listGenRef = useRef(0);
  const threadGenRef = useRef(0);

  const scope = LIVE_SYSTEM_SCOPES.has(scopeParam) || scopeParam.startsWith(NETWORK_SCOPE_PREFIX)
    ? scopeParam
    : 'inbox';
  const activeNetwork = scopeNetwork(scope);
  const unified = !activeNetwork;
  const filters = useMemo(() => filtersForScope(scope, unreadOnly), [scope, unreadOnly]);

  const setParam = useCallback((key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === null || value === undefined) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const loadNetworks = useCallback(async () => {
    const data = await api.getBeeperNetworks({ silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setNetworks(Array.isArray(data?.networks) ? data.networks : []);
  }, [mountedRef]);

  const loadList = useCallback(async () => {
    const generation = ++listGenRef.current;
    setListLoading(true);
    const [data, error] = await api.getBeeperConversations(filters, { silent: true })
      .then((value) => [value, null])
      .catch((err) => [null, err]);
    if (!mountedRef.current || generation !== listGenRef.current) return;
    if (error) {
      setListError(error?.message || 'Could not load conversations');
    } else {
      setListError(null);
      setConversations(Array.isArray(data?.conversations) ? data.conversations : []);
      setListCursor(data?.nextCursor || null);
    }
    setListLoading(false);
  }, [filters, mountedRef]);

  // "Sync now" (#79): the list-header action used to be a pure re-fetch of
  // whatever the mirror already held (`loadList` + `loadNetworks`), which is
  // why it never visibly did anything — those are plain SELECTs. This runs
  // one sweep first, then refetches, so the button's own label matches what
  // it does. `skipped: true` (a sweep was already in flight — the scheduled
  // one, most likely) still refetches: whatever that sweep has written so far
  // is worth showing.
  const [syncing, setSyncing] = useState(false);
  const syncNow = useCallback(async () => {
    setSyncing(true);
    const result = await api.syncBeeperNow({ silent: true }).catch((err) => {
      toast.error(err?.message || 'Beeper sync failed');
      return null;
    });
    if (!mountedRef.current) return;
    setSyncing(false);
    if (result?.skipped) toast('A sync is already running');
    loadList();
    loadNetworks();
  }, [loadList, loadNetworks, mountedRef]);

  // LOCAL "seen in PortOS" watermark (#83): fire the mark-seen POST and clear
  // the row's own badge immediately (optimistic), rather than waiting on the
  // next list/networks refetch to reflect it. NEVER touches Beeper — the POST
  // is a local `seen_at` stamp, not a read receipt (see the TODO on
  // `markConversationSeen` server-side for the deferred toggle that would add
  // one). The call is fire-and-forget: a failure just means the badge is
  // whatever Beeper's own `unread_count` says until the next successful call,
  // which is the same "eventually correct" posture every other mirror read
  // here already has.
  const markSeen = useCallback((id) => {
    if (!id) return;
    api.markBeeperConversationSeen(id, { silent: true }).catch(() => {});
    setConversations((prev) => (
      prev.some((row) => row.id === id && row.unreadCount > 0)
        ? prev.map((row) => (row.id === id ? { ...row, unreadCount: 0 } : row))
        : prev
    ));
  }, []);

  const loadThread = useCallback(async (id) => {
    if (!id) {
      setConversation(null);
      setMessages([]);
      setMessageCursor(null);
      setConversationMissing(false);
      setThreadError(null);
      return;
    }
    const generation = ++threadGenRef.current;
    setThreadLoading(true);
    setThreadError(null);
    const [result, error] = await Promise.all([
      api.getBeeperConversation(id, { silent: true }),
      api.getBeeperMessages(id, {}, { silent: true }),
    ]).then((value) => [value, null]).catch((err) => [null, err]);
    if (!mountedRef.current || generation !== threadGenRef.current) return;
    if (error) {
      // A 404 is "this id is gone or was never here" — a stale bookmark, not a
      // fault. It renders as not-found rather than as an error banner.
      if (error?.status === 404) {
        setConversationMissing(true);
        setConversation(null);
        setMessages([]);
      } else {
        setThreadError(error?.message || 'Could not load this conversation');
      }
    } else {
      const [detail, page] = result;
      setConversationMissing(false);
      setConversation(detail);
      setMessages(Array.isArray(page?.messages) ? page.messages : []);
      setMessageCursor(page?.nextCursor || null);
      // Opening the thread is what "seen" means here (#83) — mark it every
      // time a thread successfully loads, not only on the first open, so
      // re-navigating back into an already-open conversation still clears a
      // badge a sweep put back.
      markSeen(id);
    }
    setThreadLoading(false);
  }, [mountedRef, markSeen]);

  // The ADDITIVE counterpart to `loadThread` above, for a frame-scoped
  // invalidation refetch (findings PERF-6/BEEP-5): fetch just the first page
  // and merge it into the HEAD of `messages` by id, rather than replacing the
  // thread wholesale. `loadThread` is still correct for a real navigation (a
  // brand new conversation has no history to preserve); this one exists so an
  // invalidation on the OPEN thread never discards what the reader already
  // paged in — `messageCursor` is deliberately left untouched, since it still
  // points at the oldest page already loaded.
  //
  // Guarded like `loadMoreMessages` below (generation CAPTURED, not bumped):
  // this is compatible with an in-flight load-more for the same conversation,
  // and only needs to detect a real conversation SWITCH landing mid-fetch —
  // which `loadThread` marks by incrementing `threadGenRef` itself.
  const refreshThreadHead = useCallback(async (id) => {
    if (!id) return;
    const generation = threadGenRef.current;
    const page = await api.getBeeperMessages(id, {}, { silent: true }).catch(() => null);
    if (!mountedRef.current || generation !== threadGenRef.current || !page) return;
    const incoming = Array.isArray(page.messages) ? page.messages : [];
    if (incoming.length === 0) return;
    // Whether this refetch actually surfaced a message the thread did not
    // already have — computed against the CURRENT `messages` state before the
    // merge below, not inside `setMessages`'s own updater (whose timing is
    // not something to build a side-effect decision on). PR 86's sweep emits
    // an invalidation frame with `chatID: null` once per account, and this
    // surface's debounce treats that as "could be about anything" and
    // refetches the open thread regardless — so a 9-account sweep with
    // nothing new in THIS thread would otherwise fire ~9 no-op mark-seen
    // POSTs (an UPDATE plus a full `getConversation` read each) below.
    const existingIds = new Set(messages.map((message) => message.id));
    const hasNewMessage = incoming.some((message) => !existingIds.has(message.id));
    setMessages((prev) => {
      const incomingIds = new Set(incoming.map((message) => message.id));
      // A message already present is updated in place (the fresh copy wins)
      // rather than duplicated; everything genuinely older survives untouched
      // behind it, in whatever order `loadMoreMessages` paged it in.
      const rest = prev.filter((message) => !incomingIds.has(message.id));
      return [...incoming, ...rest];
    });
    // A new message just landed in the thread the user already has open —
    // re-stamp the watermark (#83) so the sweep that mirrored it doesn't leave
    // this conversation's badge showing again on the next list/networks
    // refetch, which would otherwise read as "unread" a thread that is
    // visibly on screen right now. Skipped when nothing was actually new: an
    // UPDATED copy of an already-known message (an edit, or the eventual
    // `message.upserted` confirmation of something already rendered) is not
    // new activity for this purpose.
    if (hasNewMessage) markSeen(id);
  }, [mountedRef, markSeen, messages]);

  useEffect(() => { loadNetworks(); }, [loadNetworks]);
  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadThread(conversationId); }, [conversationId, loadThread]);
  useEffect(() => {
    api.getTribePeople({ silent: true })
      .then((data) => { if (mountedRef.current) setPeople(Array.isArray(data) ? data : (data?.people || [])); })
      .catch(() => {});
  }, [mountedRef]);

  // Invalidation-driven refetch (#33). The frame carries no rows, so the only
  // correct reaction is to re-read the mirror. Deferred work is guarded twice:
  // the timer is cleared on unmount, and `mountedRef` stops a fetch that
  // resolves into a torn-down view.
  //
  // The list and networks refetch on ANY frame — other chats' previews and
  // unread counts genuinely do change. The OPEN THREAD is different: traffic
  // in any of the install's other chats used to reset it too (PERF-6/BEEP-5),
  // discarding whatever the reader had paged in. It now refetches only when
  // some frame seen in this window names this thread's `sourceChatId`, or
  // carries no chatID at all (a frame this vague could be about anything, so
  // the safe read is "maybe this thread" rather than "not this thread") — and
  // even then, additively via `refreshThreadHead`, never via `loadThread`.
  const refetchRef = useRef({
    loadList, loadThread, loadNetworks, refreshThreadHead, conversationId, sourceChatId: conversation?.sourceChatId ?? null,
  });
  refetchRef.current = {
    loadList, loadThread, loadNetworks, refreshThreadHead, conversationId, sourceChatId: conversation?.sourceChatId ?? null,
  };
  // Anchors the MAX-WAIT ceiling to the first frame of the current window; see
  // `INVALIDATION_MAX_WAIT_MS`. Reset only when a timer actually fires, never
  // by the effect's own cleanup — the cleanup fires on every frame in a burst
  // just to reschedule, and resetting there would defeat the ceiling entirely.
  const invalidationWindowStartRef = useRef(null);
  useEffect(() => {
    if (!invalidationSeq) return undefined;
    const now = Date.now();
    if (invalidationWindowStartRef.current === null) invalidationWindowStartRef.current = now;
    const elapsed = now - invalidationWindowStartRef.current;
    const wait = Math.max(0, Math.min(INVALIDATION_DEBOUNCE_MS, INVALIDATION_MAX_WAIT_MS - elapsed));
    const timer = setTimeout(() => {
      invalidationWindowStartRef.current = null;
      if (!mountedRef.current) return;
      const current = refetchRef.current;
      current.loadList();
      current.loadNetworks();
      const frames = invalidationFrames?.current || [];
      if (invalidationFrames) invalidationFrames.current = [];
      const inScope = frames.some((frame) => (
        !frame || frame.chatID === null || frame.chatID === undefined || frame.chatID === current.sourceChatId
      ));
      if (current.conversationId && inScope) current.refreshThreadHead(current.conversationId);
    }, wait);
    return () => clearTimeout(timer);
  }, [invalidationSeq, mountedRef, invalidationFrames]);

  // The scope and the unread filter ride along on every selection change, so a
  // shared conversation link reopens the list the sender was looking at.
  const querySuffix = useMemo(() => {
    const encoded = searchParams.toString();
    return encoded ? `?${encoded}` : '';
  }, [searchParams]);

  const selectConversation = useCallback((id) => {
    navigate(`/messages/beeper/${encodeURIComponent(id)}${querySuffix}`);
  }, [navigate, querySuffix]);

  const clearSelection = useCallback(() => {
    navigate(`/messages/beeper${querySuffix}`);
  }, [navigate, querySuffix]);

  // The Tribe link (#98 parts A/C): the title chip for a linked 1:1 chat, and
  // the "Linked · <name>" row in the participants panel, both jump to the
  // Tribe page pre-selected on that person via `?person=<id>` (Tribe.jsx
  // reads it, switches to the Circle tab, and scrolls the card into view).
  const openTribePerson = useCallback((personId) => {
    if (!personId) return;
    navigate(`/tribe?person=${encodeURIComponent(personId)}`);
  }, [navigate]);

  const setDraft = useCallback((value) => {
    if (!conversationId) return;
    setDrafts((prev) => {
      const next = { ...prev, [conversationId]: value };
      if (!value) delete next[conversationId];
      safeWriteJsonStorage(DRAFTS_STORAGE_KEY, next);
      return next;
    });
  }, [conversationId]);

  // The composer's send lifecycle (#36, wired here on #53). `onSent` clears
  // the PortOS-side draft buffer the same way any other draft edit does —
  // through `setDraft`, so it also drops the persisted `drafts` entry rather
  // than leaving a stale one in localStorage under a conversation that no
  // longer needs it.
  const {
    entries: outboxEntries,
    sending: outboxSending,
    confirmation: outboxConfirmation,
    submit: sendOutboxMessage,
    confirmAndSend: confirmOutboxSend,
    cancelConfirmation: cancelOutboxConfirmation,
    retry: retryOutboxEntry,
    dismiss: dismissOutboxEntry,
  } = useBeeperOutbox(conversationId, {
    onSent: (sentConversationId, body) => setDrafts((prev) => {
      // A send can finish after navigation or another draft edit. Clear only
      // the text actually sent, in the conversation that owned the request.
      if (prev[sentConversationId]?.trim() !== body?.trim()) return prev;
      const next = { ...prev };
      delete next[sentConversationId];
      safeWriteJsonStorage(DRAFTS_STORAGE_KEY, next);
      return next;
    }),
  });

  const loadMoreMessages = useCallback(async () => {
    if (!conversationId || !messageCursor) return;
    const generation = threadGenRef.current;
    setLoadingMore(true);
    try {
      const page = await api.getBeeperMessages(conversationId, { cursor: messageCursor }, { silent: true }).catch(() => null);
      // A conversation switch mid-load bumps `threadGenRef` (via `loadThread`),
      // and this response belongs to the conversation the reader left — it
      // must not land, but `loadingMore` still has to come back down, or
      // "Load earlier messages" on the NEW conversation renders permanently
      // disabled (finding T3). The `finally` below is what guarantees that.
      if (!mountedRef.current || generation !== threadGenRef.current) return;
      if (page) {
        setMessages((prev) => [...prev, ...(Array.isArray(page.messages) ? page.messages : [])]);
        setMessageCursor(page.nextCursor || null);
      }
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  }, [conversationId, messageCursor, mountedRef]);

  // A synchronous in-flight latch, mirroring `submittingRef` in
  // `useBeeperOutbox.js` (finding T5): `listGenRef`/`listLoading` alone do not
  // stop two clicks landing inside the same render from both reading "not
  // loading yet" and both firing the same cursor page, appending it twice.
  // The ref latches before the first `await`, so the second call returns
  // immediately no matter how close together the two clicks are.
  const loadingListRef = useRef(false);
  const loadMoreConversations = useCallback(async () => {
    if (!listCursor || loadingListRef.current) return;
    loadingListRef.current = true;
    const generation = listGenRef.current;
    try {
      const page = await api.getBeeperConversations({ ...filters, cursor: listCursor }, { silent: true }).catch(() => null);
      if (!mountedRef.current || generation !== listGenRef.current) return;
      if (page) {
        setConversations((prev) => [...prev, ...(Array.isArray(page.conversations) ? page.conversations : [])]);
        setListCursor(page.nextCursor || null);
      }
    } finally {
      loadingListRef.current = false;
    }
  }, [filters, listCursor, mountedRef]);

  // Both wired rail controls go through one path: the write reaches Beeper, and
  // the response — not an optimistic guess — updates local state. A write never
  // retries, so a failure is reported once and left failed.
  const applyFlag = useCallback(async (writer, value, label) => {
    if (!conversationId) return;
    setWritePending(true);
    const updated = await writer(conversationId, value, { silent: true }).catch((err) => {
      toast.error(err?.message || `Could not ${label} this conversation`);
      return null;
    });
    if (!mountedRef.current) return;
    setWritePending(false);
    if (!updated) return;
    // The open thread's own row is set from the server's answer; the LIST is
    // refetched rather than merged, because archiving changes which scope a
    // conversation belongs to — a local merge would leave it sitting in a
    // scope it no longer matches until the next load anyway.
    setConversation(updated);
    loadList();
  }, [conversationId, loadList, mountedRef]);

  // Purging one conversation's mirror. Local state is updated from the result
  // rather than refetched: the row is gone, the thread has nothing left to
  // show, and the surface navigates back to the list it came from.
  const purgeMirror = useCallback(async () => {
    if (!conversationId) return;
    setPurging(true);
    const result = await api.purgeBeeperConversation(conversationId, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not purge this conversation');
      return null;
    });
    if (!mountedRef.current) return;
    setPurging(false);
    if (!result) return;
    setConversations((prev) => prev.filter((row) => row.id !== conversationId));
    // The purge removes every message the mirror held for this conversation,
    // so a drafted-but-unsent reply left in `drafts` would otherwise survive
    // it forever in localStorage — nothing else ever clears an entry once its
    // conversation is gone from the list. Same shape `setDraft` uses.
    setDraft('');
    toast.success(`Mirror purged — ${result.messagesRemoved} message(s), ${result.filesRemoved} attachment file(s) removed`);
    clearSelection();
  }, [clearSelection, conversationId, mountedRef, setDraft]);

  // One attachment changed under the thread (a "fetch anyway", a keep toggle).
  // Merge it into the message it belongs to instead of refetching the page —
  // the rest of the thread has not moved.
  const applyAttachmentUpdate = useCallback((messageId, updated) => {
    setMessages((prev) => prev.map((message) => (
      message.id === messageId
        ? {
          ...message,
          attachments: (message.attachments || []).map((attachment) => (
            attachment.idx === updated.idx ? { ...attachment, ...updated } : attachment
          )),
        }
        : message
    )));
  }, []);

  const linkParticipant = useCallback(async (participant, personId) => {
    setLinkingId(participant.sourceUserId);
    const result = await api.linkBeeperParticipant({
      conversationId, sourceUserId: participant.sourceUserId, personId,
    }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not link this participant');
      return null;
    });
    if (!mountedRef.current) return;
    setLinkingId(null);
    if (!result) return;
    if (result.displacedPersonId) toast.success('Handle moved from another Tribe person');
    loadThread(conversationId);
  }, [conversationId, loadThread, mountedRef]);

  // The confirm-and-rename form (#97 part A) hands back the edited fields
  // rather than this callback inventing them from the participant's raw
  // display name — the whole point of the form is that the name posted is
  // the one the user confirmed or corrected, not whatever Beeper reported.
  const createAndLinkParticipant = useCallback(async (participant, { name, ring, relationship } = {}) => {
    setLinkingId(participant.sourceUserId);
    const result = await api.createTribePersonFromBeeper({
      conversationId,
      sourceUserId: participant.sourceUserId,
      name: name || participant.displayName || participant.handle || undefined,
      ring,
      relationship,
    }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not create a Tribe person');
      return null;
    });
    if (!mountedRef.current) return;
    setLinkingId(null);
    if (!result) return;
    toast.success('Linked to a new Tribe person');
    loadThread(conversationId);
    api.getTribePeople({ silent: true })
      .then((data) => { if (mountedRef.current) setPeople(Array.isArray(data) ? data : (data?.people || [])); })
      .catch(() => {});
  }, [conversationId, loadThread, mountedRef]);

  // Unlink (#97 part B): the row's affordances flip immediately — cleared
  // optimistically in the loaded thread the same shape `linkParticipant`'s
  // successful result carries (`tribePersonId`/`tribePersonName`) — and then
  // `loadThread` settles the truth from the server either way, the same
  // refresh-after-write shape every other write in this surface uses.
  const unlinkParticipant = useCallback(async (participant) => {
    setLinkingId(participant.sourceUserId);
    setConversation((prev) => (prev ? {
      ...prev,
      participants: (prev.participants || []).map((row) => (
        row.sourceUserId === participant.sourceUserId
          ? { ...row, tribePersonId: null, tribePersonName: null }
          : row
      )),
    } : prev));
    await api.unlinkBeeperParticipant({
      conversationId, sourceUserId: participant.sourceUserId,
    }, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not unlink this participant');
      return null;
    });
    if (!mountedRef.current) return;
    setLinkingId(null);
    loadThread(conversationId);
  }, [conversationId, loadThread, mountedRef]);

  const pinned = useMemo(
    () => conversations.filter((row) => row.isPinned).slice(0, PINNED_GRID_CAP),
    [conversations],
  );
  const totalUnread = useMemo(
    () => networks.reduce((sum, entry) => sum + (entry.unreadCount || 0), 0),
    [networks],
  );
  const scopeLabel = activeNetwork
    ? networkLabel(activeNetwork)
    : (SYSTEM_SCOPES.find((entry) => entry.id === scope)?.label || 'Inbox');

  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      <Rail
        networks={networks}
        scope={scope}
        onScope={(next) => setParam('scope', next)}
        totalUnread={totalUnread}
        onOpenSettings={onOpenSettings}
      />

      {/* The thread pane only appears at `md`, so the list is full width below
          it: a fixed 280px column in the 640–767px band put a narrow strip
          beside dead space. */}
      <div className={`flex min-h-0 w-full flex-col border-port-border md:w-[280px] md:shrink-0 md:border-r ${conversationId ? 'hidden md:flex' : 'flex'}`}>
        {/* Liveness renders on exactly two surfaces (#12 decision 4): this
            Moltworld-shape dot, and the settings card for an actionable fault.
            There is no global banner, and the dot lives at the head of the
            scope column rather than inside the 68px icon rail, where the
            component's status word has nowhere to go. `null` = the transport
            has not reported yet, and is never drawn as offline. */}
        {realtime?.state && (
          <div className="shrink-0 border-b border-port-border/60 px-3 py-1.5">
            <ConnectionStatusDot status={realtime.state} label="Realtime:" className="text-[11px]" />
          </div>
        )}

        <SyncStrip sweep={sweep} />

        <div className="flex shrink-0 items-center gap-1 px-3 py-2.5">
          <span className="flex min-w-0 items-center gap-1 text-sm font-semibold text-white">
            {/* No chevron here (audit cluster 08, COPY-3): a scope-picker menu
                does not exist, and an inert control that looks live is worse
                than an absent one — the file's own governing rule. */}
            <span className="truncate">{scopeLabel}</span>
          </span>
          <button
            type="button"
            onClick={() => setParam('unread', unreadOnly ? null : '1')}
            title="Unread only"
            aria-label="Unread only"
            aria-pressed={unreadOnly}
            className={`ml-auto inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1.5 ${unreadOnly ? 'bg-port-accent text-port-bg' : 'text-gray-500 hover:text-white'}`}
          >
            <Filter size={15} />
          </button>
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            title="Sync now — runs a Beeper sweep immediately, then refreshes this list"
            aria-label="Sync now"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1.5 text-gray-500 hover:text-white disabled:opacity-50"
          >
            <RefreshCw size={15} className={syncing || listLoading ? 'animate-spin' : undefined} />
          </button>
          <InertControl icon={Search} label="Search conversations" className="rounded p-1.5 text-gray-500" />
          <InertControl icon={PenSquare} label="New conversation" className="rounded p-1.5 text-gray-500" />
        </div>

        {listError && (
          <p role="alert" className="mx-3 mb-2 rounded border border-port-error/40 bg-port-error/10 px-2 py-1.5 text-[11px] text-port-error">
            {listError}
          </p>
        )}

        {!unreadOnly && <PinnedGrid conversations={pinned} unified={unified} onSelect={selectConversation} />}

        {listLoading && conversations.length === 0 ? (
          <p className="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-gray-500">
            <Loader2 size={12} className="animate-spin" /> Loading conversations…
          </p>
        ) : conversations.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-sm text-gray-300">Nothing here</p>
            {/* The reassurance below only makes sense once the list itself is
                known-good (#3/A11Y-3): a failed fetch already explains itself
                via the error banner above, and repeating "often correct" right
                under it read as a contradiction. Zero mirrored networks and an
                active unread filter are their own, more useful answers than a
                generic count. */}
            {!listError && (
              <p className="text-[11px] text-gray-500">
                {networks.length === 0 ? (
                  // Branches on `tokenConfigured` (#80), not on `networks.length`
                  // alone: a connected install whose first sweep just hasn't
                  // written a network row yet is a different state from one
                  // that was never told to connect anything, and telling the
                  // first case to "open settings" sends a user who already did
                  // that back to the same drawer for no reason.
                  tokenConfigured ? (
                    'First sync in progress — give it a moment and mirrored networks will start appearing here.'
                  ) : (
                    <>
                      Nothing is mirrored yet.{' '}
                      <button
                        type="button"
                        onClick={onOpenSettings}
                        className="text-port-accent underline underline-offset-2"
                      >
                        Open Beeper settings
                      </button>{' '}
                      to connect a network.
                    </>
                  )
                ) : unreadOnly ? (
                  'The unread filter is on — nothing unread here.'
                ) : (
                  <>
                    {networks.length} network{networks.length === 1 ? '' : 's'} mirrored. History depth varies
                    enormously per network, so an empty list is often correct rather than broken.
                  </>
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="min-h-0 flex-1 divide-y divide-port-border/50 overflow-y-auto">
            {conversations.map((row) => (
              <ConversationRow
                key={row.id}
                conversation={row}
                unified={unified}
                selected={conversationId === row.id}
                onSelect={selectConversation}
              />
            ))}
            {listCursor && (
              <div className="p-2 text-center">
                <button
                  type="button"
                  onClick={loadMoreConversations}
                  className="min-h-[32px] rounded-full border border-port-border px-3 text-[11px] text-gray-300 transition-colors hover:border-port-accent"
                >
                  Load more
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`min-h-0 flex-1 ${conversationId ? 'flex flex-col' : 'hidden md:flex md:flex-col'}`}>
        {conversationMissing ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm text-gray-300">Conversation not found</p>
            <p className="max-w-sm text-[11px] text-gray-500">
              This link points at a conversation that is not in the mirror — it may have been removed, or belong to an
              account that is no longer connected.
            </p>
            <button
              type="button"
              onClick={clearSelection}
              className="min-h-[36px] rounded-lg border border-port-border px-3 text-xs text-gray-200 transition-colors hover:border-port-accent"
            >
              Back to conversations
            </button>
          </div>
        ) : (
          <BeeperThread
            conversation={conversation}
            messages={messages}
            loading={threadLoading}
            error={threadError}
            hasMore={Boolean(messageCursor)}
            loadingMore={loadingMore}
            onLoadMore={loadMoreMessages}
            draft={drafts[conversationId] || ''}
            onDraftChange={setDraft}
            outboxEntries={outboxEntries}
            sending={outboxSending}
            confirmation={outboxConfirmation}
            onSend={sendOutboxMessage}
            confirmAndSend={confirmOutboxSend}
            cancelConfirmation={cancelOutboxConfirmation}
            retryOutboxEntry={retryOutboxEntry}
            dismissOutboxEntry={dismissOutboxEntry}
            breaker={breaker}
            people={people}
            linkingId={linkingId}
            onLinkParticipant={linkParticipant}
            onCreateAndLinkParticipant={createAndLinkParticipant}
            onUnlinkParticipant={unlinkParticipant}
            onOpenTribePerson={openTribePerson}
            onBack={clearSelection}
            onRetry={conversationId ? () => loadThread(conversationId) : null}
            writePending={writePending}
            onArchive={(value) => applyFlag(api.setBeeperConversationArchived, value, 'archive')}
            onLowPriority={(value) => applyFlag(api.setBeeperConversationLowPriority, value, 'update')}
            onPurge={purgeMirror}
            purging={purging}
            onAttachmentUpdated={applyAttachmentUpdate}
          />
        )}
      </div>
    </div>
  );
}
