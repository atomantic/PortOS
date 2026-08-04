import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Mail, Search, RefreshCw, ChevronRight, Sparkles, Archive, Trash2, Reply, Eye, Flag, Pin, Loader2, Settings, FilterX, AlertTriangle } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import socket from '../../services/socket';
import { timeAgo } from '../../utils/formatters';
import MessageDetail from './MessageDetail';

const ACTION_CONFIG = {
  reply:   { icon: Reply,   color: 'text-port-accent',  bg: 'bg-port-accent/10',  hoverBg: 'hover:bg-port-accent/20',  label: 'Reply' },
  archive: { icon: Archive,  color: 'text-gray-400',     bg: 'bg-gray-500/10',     hoverBg: 'hover:bg-gray-500/20',     label: 'Archive' },
  delete:  { icon: Trash2,   color: 'text-port-error',   bg: 'bg-port-error/10',   hoverBg: 'hover:bg-port-error/20',   label: 'Delete' },
  review:  { icon: Eye,      color: 'text-port-warning', bg: 'bg-port-warning/10', hoverBg: 'hover:bg-port-warning/20', label: 'Review' }
};

const ACTION_ORDER = ['reply', 'review', 'archive', 'delete'];

// Email sources that support archive/delete actions
const ACTIONABLE_SOURCES = ['outlook', 'gmail'];

const PRIORITY_DOT = {
  high: 'bg-port-error',
  medium: 'bg-port-warning',
  low: 'bg-gray-500'
};

const TRIAGE_TABS = [
  { key: 'all',       label: 'All',       icon: Mail,    filter: () => true },
  { key: 'reply',     label: 'Reply',     icon: Reply,   filter: m => m.evaluation?.action === 'reply' },
  { key: 'review',    label: 'Review',    icon: Eye,     filter: m => m.evaluation?.action === 'review' },
  { key: 'archive',   label: 'Archive',   icon: Archive, filter: m => m.evaluation?.action === 'archive' },
  { key: 'delete',    label: 'Delete',    icon: Trash2,  filter: m => m.evaluation?.action === 'delete' },
  { key: 'untriaged', label: 'Untriaged', icon: Mail,    filter: m => !m.evaluation },
];

const EMPTY_ACTION_CLASS = 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm transition-colors disabled:opacity-50';

/**
 * Newest `lastSyncAt` across the given accounts, or `null` when none has ever
 * synced. `null` here means "never synced" — never "synced and found nothing".
 * Timestamps are compared as parsed dates rather than lexicographically, so a
 * stamp written with a UTC offset can't sort ahead of a newer `Z` one; an
 * unparseable stamp is skipped (worst case the caller offers a sync that isn't
 * strictly needed, rather than rendering "last synced never").
 * @param {Array<{lastSyncAt?: string|null}>} accounts
 * @returns {string|null} ISO timestamp or null
 */
export function latestSyncAt(accounts) {
  if (!Array.isArray(accounts)) return null;
  let newest = null;
  let newestMs = -Infinity;
  for (const account of accounts) {
    const stamp = account?.lastSyncAt;
    if (!stamp) continue;
    const ms = new Date(stamp).getTime();
    if (!Number.isFinite(ms) || ms <= newestMs) continue;
    newest = stamp;
    newestMs = ms;
  }
  return newest;
}

/**
 * Empty state for the inbox list. The action the user still has to take depends
 * on where they actually are, so this branches instead of always telling them to
 * "add an account and sync" — advice that was wrong for every user who already
 * had an account configured (#3281).
 *
 * `accounts === null` is the load-failed / not-loaded sentinel and is distinct
 * from `[]` ("loaded, and there are genuinely no accounts"); likewise a null
 * `lastSyncAt` means "never synced", not "synced and found nothing".
 */
export function InboxEmptyState({ accounts, lastSyncAt, hasFilters, syncing, onSync, onClearFilters }) {
  const navigate = useNavigate();

  const body = (() => {
    if (!Array.isArray(accounts)) return {
      Icon: AlertTriangle,
      title: 'Could not load your mail accounts',
      hint: 'The inbox cannot tell what is configured until that request succeeds.',
      action: (
        <button
          onClick={() => navigate('/messages/config')}
          className={`${EMPTY_ACTION_CLASS} bg-port-accent/10 text-port-accent hover:bg-port-accent/20`}
        >
          <Settings size={14} />
          Open Config
        </button>
      )
    };

    if (accounts.length === 0) return {
      Icon: Mail,
      title: 'No messages yet',
      hint: 'Add an account and sync to get started',
      action: (
        <button
          onClick={() => navigate('/messages/config')}
          className={`${EMPTY_ACTION_CLASS} bg-port-accent/10 text-port-accent hover:bg-port-accent/20`}
        >
          <Settings size={14} />
          Add an account
        </button>
      )
    };

    if (!lastSyncAt) return {
      Icon: RefreshCw,
      title: 'Nothing synced yet',
      hint: 'Pull your latest mail to fill the inbox',
      action: (
        <button
          onClick={onSync}
          disabled={syncing}
          className={`${EMPTY_ACTION_CLASS} bg-port-accent/10 text-port-accent hover:bg-port-accent/20`}
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync Unread'}
        </button>
      )
    };

    if (hasFilters) return {
      Icon: Mail,
      title: 'No messages match this view',
      hint: `Last synced ${timeAgo(lastSyncAt)}`,
      action: (
        <button
          onClick={onClearFilters}
          className={`${EMPTY_ACTION_CLASS} bg-port-border text-gray-300 hover:bg-port-border/80`}
        >
          <FilterX size={14} />
          Clear filters
        </button>
      )
    };

    return {
      Icon: Mail,
      title: 'Your inbox is empty',
      hint: `The last sync brought back nothing new — last synced ${timeAgo(lastSyncAt)}`,
      action: (
        <button
          onClick={onSync}
          disabled={syncing}
          className={`${EMPTY_ACTION_CLASS} bg-port-accent/10 text-port-accent hover:bg-port-accent/20`}
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync Unread'}
        </button>
      )
    };
  })();

  const { Icon, title, hint, action } = body;
  return (
    <div className="text-center py-12 px-4 text-gray-500">
      <Icon size={48} className="mx-auto mb-4 opacity-50" />
      <p className="text-gray-300">{title}</p>
      <p className="text-sm mt-1">{hint}</p>
      <div className="mt-4 flex justify-center">{action}</div>
    </div>
  );
}

export default function InboxTab({ accounts }) {
  // Everything below iterates the list; the `null` load-failed sentinel is only
  // meaningful to the empty state, which reads `accounts` directly.
  const accountList = useMemo(() => accounts || [], [accounts]);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [evaluating, setEvaluating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // accountId -> ISO timestamp for syncs that succeeded in this session, so the
  // empty state stops saying "never synced" without waiting for the parent to
  // refetch accounts. Keyed by account because the account filter narrows which
  // accounts the empty state is speaking about.
  const [syncedAtById, setSyncedAtById] = useState({});
  const [fetchingFull, setFetchingFull] = useState(false);
  const [actionInProgress, setActionInProgress] = useState(null);
  const debounceRef = useRef(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTriage = searchParams.get('triage');
  const VALID_TRIAGE_KEYS = TRIAGE_TABS.map(t => t.key);
  const activeTab = VALID_TRIAGE_KEYS.includes(rawTriage) ? rawTriage : 'all';
  const setActiveTab = (key) => {
    const p = new URLSearchParams(searchParams);
    if (key === 'all') p.delete('triage');
    else p.set('triage', key);
    setSearchParams(p, { replace: true });
  };

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  const fetchMessages = useCallback(async () => {
    setLoading(true);
    const params = {};
    if (selectedAccount) params.accountId = selectedAccount;
    if (debouncedSearch) params.search = debouncedSearch;
    const result = await api.getMessageInbox(params).catch(() => ({ messages: [], total: 0 }));
    setMessages(result.messages || []);
    setLoading(false);
  }, [selectedAccount, debouncedSearch]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Stream messages into the list as they arrive during sync
  useEffect(() => {
    const onSyncMessage = ({ messages: incoming }) => {
      if (!incoming?.length) return;
      setMessages(prev => {
        const byExtId = new Map(prev.map(m => [m.externalId, m]));
        let changed = false;
        for (const msg of incoming) {
          if (msg.externalId && byExtId.has(msg.externalId)) {
            const existing = byExtId.get(msg.externalId);
            byExtId.set(msg.externalId, { ...existing, ...msg, id: existing.id });
            changed = true;
          } else {
            byExtId.set(msg.externalId || msg.id, msg);
            changed = true;
          }
        }
        if (!changed) return prev;
        return Array.from(byExtId.values()).sort((a, b) =>
          new Date(b.date || 0) - new Date(a.date || 0)
        );
      });
    };
    socket.on('messages:sync:message', onSyncMessage);
    return () => socket.off('messages:sync:message', onSyncMessage);
  }, []);

  const handleSync = async (mode) => {
    const targets = selectedAccount
      ? accountList.filter(a => a.id === selectedAccount && a.enabled)
      : accountList.filter(a => a.enabled);
    if (targets.length === 0) return toast.error('No enabled accounts to sync');
    setSyncing(true);
    let totalNew = 0;
    let totalPruned = 0;
    const syncedNow = {};
    for (const acct of targets) {
      toast(`Syncing ${acct.name} (${mode})...`, { icon: '📧' });
      const result = await api.syncMessageAccount(acct.id, mode, { silent: true }).catch(err => {
        toast.error(`${acct.name}: ${err?.message || 'Sync failed'}`);
        return null;
      });
      if (!result) continue;
      syncedNow[acct.id] = new Date().toISOString();
      if (result.newMessages) totalNew += result.newMessages;
      if (result.pruned) totalPruned += result.pruned;
    }
    setSyncing(false);
    // Every account failing is not a completed sync — stay quiet, and leave the
    // "never synced" state intact so the empty state keeps offering the retry.
    if (Object.keys(syncedNow).length === 0) return;
    setSyncedAtById(prev => ({ ...prev, ...syncedNow }));
    const parts = [`${totalNew} new`];
    if (totalPruned > 0) parts.push(`${totalPruned} removed`);
    toast.success(`Sync complete — ${parts.join(', ')}`);
    fetchMessages();
  };

  const handleEvaluate = async () => {
    setEvaluating(true);
    const data = selectedAccount ? { accountId: selectedAccount } : {};
    const result = await api.evaluateMessages(data, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Evaluation failed');
      return null;
    });
    setEvaluating(false);
    if (!result) return;
    const count = Object.keys(result.evaluations || {}).length;
    toast.success(`Evaluated ${count} messages`);
    // Merge evaluations into local state
    setMessages(prev => prev.map(m => {
      const ev = result.evaluations?.[m.id];
      return ev ? { ...m, evaluation: ev } : m;
    }));
  };

  const handleQuickReply = async (msg, e) => {
    e.stopPropagation();
    const account = accountList.find(a => a.id === msg.accountId) || accountList[0];
    if (!account) return toast.error('No account available');
    toast('Generating AI reply...', { icon: '✨' });
    const draft = await api.generateMessageDraft({
      accountId: account.id,
      replyToMessageId: msg.id,
      threadId: msg.threadId,
      context: `Replying to: "${msg.subject}" from ${msg.from?.name || msg.from?.email}`,
      instructions: ''
    }).catch(() => null);
    if (draft) {
      toast.success('Draft created — opening Drafts');
      navigate('/messages/drafts');
    }
  };

  const handleAction = async (msg, action, e) => {
    e.stopPropagation();
    if (actionInProgress) return;
    const account = accountList.find(a => a.id === msg.accountId);
    if (!account) return toast.error('No account found for this message');
    if (!ACTIONABLE_SOURCES.includes(msg.source || account.type)) {
      return toast.error(`${action} not supported for ${msg.source || account.type}`);
    }
    setActionInProgress(msg.id);
    toast(`${action === 'archive' ? 'Archiving' : 'Deleting'}...`, { icon: '📧' });
    const result = await api.executeMessageAction(msg.accountId, msg.id, action, { silent: true }).catch(err => {
      toast.error(err?.message || `${action} failed`);
      return null;
    });
    setActionInProgress(null);
    if (result?.success) {
      toast.success(`Message ${action === 'archive' ? 'archived' : 'deleted'}`);
      setMessages(prev => prev.filter(m => m.id !== msg.id));
    }
  };

  // The active triage tab and its filtered message list are derived from
  // messages + activeTab; memoize so the O(n) filter runs once per change
  // instead of twice on every render (empty-state check + the rendered list).
  const currentTab = useMemo(
    () => TRIAGE_TABS.find(t => t.key === activeTab) || TRIAGE_TABS[0],
    [activeTab]
  );
  const visibleMessages = useMemo(
    () => messages.filter(currentTab.filter),
    [messages, currentTab]
  );

  // Scope the "have we ever synced?" answer to the accounts the current view can
  // show — with an account filter on, another account's sync says nothing about
  // this one. A sync that landed in this session wins over the (not-yet-refetched)
  // account timestamps; absent both, these accounts have genuinely never synced.
  const lastSyncAt = useMemo(() => {
    const scoped = selectedAccount
      ? accountList.filter(a => a.id === selectedAccount)
      : accountList;
    return latestSyncAt(scoped.map(a => ({ lastSyncAt: syncedAtById[a.id] || a.lastSyncAt })));
  }, [accountList, selectedAccount, syncedAtById]);
  // Search and account are applied server-side in fetchMessages, the triage tab
  // client-side — all three narrow what the list can show, so all three make
  // "nothing here" a filtering result rather than an empty mailbox.
  const hasFilters = Boolean(debouncedSearch || selectedAccount || activeTab !== 'all');
  const clearFilters = () => {
    setSearch('');
    setSelectedAccount('');
    setActiveTab('all');
  };

  if (selectedMessage) {
    return (
      <MessageDetail
        message={selectedMessage}
        accounts={accountList}
        onBack={() => { setSelectedMessage(null); fetchMessages(); }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search messages..."
            className="w-full pl-9 pr-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
          />
        </div>
        <select
          value={selectedAccount}
          onChange={(e) => setSelectedAccount(e.target.value)}
          className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-sm text-white focus:outline-none focus:border-port-accent"
        >
          <option value="">All accounts</option>
          {accountList.map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <button
          onClick={handleEvaluate}
          disabled={evaluating || syncing}
          className="flex items-center gap-1 px-3 py-2 bg-port-accent-2/10 text-port-accent-2 rounded-lg text-sm hover:bg-port-accent-2/20 transition-colors disabled:opacity-50"
          title="AI triage — evaluate messages for recommended actions"
        >
          <Sparkles size={14} className={evaluating ? 'animate-pulse' : ''} />
          {evaluating ? 'Evaluating...' : 'Triage'}
        </button>
        <button
          onClick={() => handleSync('unread')}
          disabled={syncing}
          className="flex items-center gap-1 px-3 py-2 bg-port-accent/10 text-port-accent rounded-lg text-sm hover:bg-port-accent/20 transition-colors disabled:opacity-50"
          title="Sync unread messages from all enabled accounts"
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync Unread'}
        </button>
        <button
          onClick={() => handleSync('full')}
          disabled={syncing}
          className="flex items-center gap-1 px-3 py-2 bg-port-border text-gray-300 rounded-lg text-sm hover:bg-port-border/80 transition-colors disabled:opacity-50"
          title="Full sync — fetch all messages (slower)"
        >
          Full Sync
        </button>
        {selectedAccount && (
          <button
            onClick={async () => {
              setFetchingFull(true);
              const result = await api.fetchFullContent(selectedAccount).catch(() => null);
              setFetchingFull(false);
              if (!result) return;
              toast.success(`Fetched full content for ${result.count || 0} messages`);
              fetchMessages();
            }}
            disabled={fetchingFull}
            className="flex items-center gap-1 px-3 py-2 bg-port-warning/10 text-port-warning rounded-lg text-sm hover:bg-port-warning/20 transition-colors disabled:opacity-50"
            title="Fetch full body content for messages with preview-only text"
          >
            <RefreshCw size={14} className={fetchingFull ? 'animate-spin' : ''} />
            {fetchingFull ? 'Fetching...' : 'Fetch Full Content'}
          </button>
        )}
        {selectedAccount && (
          <button
            onClick={async () => {
              setFetchingFull(true);
              const result = await api.fetchFullContent(selectedAccount, { force: true }).catch(() => null);
              setFetchingFull(false);
              if (!result) return;
              toast.success(`Re-fetched content for ${result.updated || 0}/${result.total || 0} messages`);
              fetchMessages();
            }}
            disabled={fetchingFull}
            className="flex items-center gap-1 px-3 py-2 bg-port-error/10 text-port-error rounded-lg text-sm hover:bg-port-error/20 transition-colors disabled:opacity-50"
            title="Re-fetch body content for ALL messages (use if content was imported incorrectly)"
          >
            <RefreshCw size={14} className={fetchingFull ? 'animate-spin' : ''} />
            {fetchingFull ? 'Fetching...' : 'Re-fetch All Content'}
          </button>
        )}
      </div>

      {/* Triage filter tabs */}
      <div className="flex items-center gap-1 border-b border-port-border pb-1">
        {TRIAGE_TABS.map(tab => {
          const count = messages.filter(tab.filter).length;
          const TabIcon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t text-xs transition-colors ${
                isActive
                  ? 'bg-port-card text-white border border-port-border border-b-transparent -mb-[1px]'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              <TabIcon size={12} />
              {tab.label}
              {count > 0 && <span className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] ${isActive ? 'bg-port-accent/20 text-port-accent' : 'bg-port-border text-gray-400'}`}>{count}</span>}
            </button>
          );
        })}
      </div>

      {visibleMessages.length === 0 && !loading && (
        <InboxEmptyState
          accounts={accounts}
          lastSyncAt={lastSyncAt}
          hasFilters={hasFilters}
          syncing={syncing}
          onSync={() => handleSync('unread')}
          onClearFilters={clearFilters}
        />
      )}

      <div className="space-y-1">
        {visibleMessages.map((msg) => {
          const ev = msg.evaluation;
          return (
            <div
              key={msg.id}
              className={`flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-port-card group ${
                msg.isRead && !msg.isUnread ? 'opacity-70' : ''
              }`}
            >
              {/* Priority dot + flags */}
              <div className="flex flex-col items-center gap-1 w-4 shrink-0">
                {ev && <span className={`w-2 h-2 rounded-full ${PRIORITY_DOT[ev.priority] || PRIORITY_DOT.medium}`} title={`${ev.priority} priority`} />}
                {msg.isPinned && <Pin size={10} className="text-gray-500" />}
                {msg.isFlagged && <Flag size={10} className="text-port-warning" />}
              </div>

              {/* Message content — clickable */}
              <button
                onClick={() => setSelectedMessage(msg)}
                className="flex-1 min-w-0 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className={`text-sm truncate ${msg.isUnread || !msg.isRead ? 'text-white font-medium' : 'text-gray-400'}`}>
                    {msg.from?.name || msg.from?.email || 'Unknown'}
                  </span>
                  <span className="text-xs text-gray-600 shrink-0">
                    {msg.date ? new Date(msg.date).toLocaleDateString() : ''}
                  </span>
                </div>
                <div className={`text-sm truncate ${msg.isUnread || !msg.isRead ? 'text-gray-300' : 'text-gray-500'}`}>
                  {msg.subject || '(no subject)'}
                </div>
                <div className="text-xs text-gray-600 truncate">
                  {msg.bodyText?.substring(0, 100) || ''}
                </div>
              </button>

              {/* Action buttons — always show all, highlight AI recommendation */}
              <div className="flex items-center gap-1 shrink-0">
                {ACTION_ORDER.map(actionKey => {
                  const cfg = ACTION_CONFIG[actionKey];
                  const Icon = cfg.icon;
                  const isRecommended = ev?.action === actionKey;
                  const msgSource = msg.source || accountList.find(a => a.id === msg.accountId)?.type;
                  const isActionable = ['archive', 'delete'].includes(actionKey) && ACTIONABLE_SOURCES.includes(msgSource);

                  const onClick = actionKey === 'reply'
                    ? (e) => handleQuickReply(msg, e)
                    : actionKey === 'review'
                      ? (e) => { e.stopPropagation(); setSelectedMessage(msg); }
                      : isActionable
                        ? (e) => handleAction(msg, actionKey, e)
                        : (e) => { e.stopPropagation(); setSelectedMessage(msg); };

                  const title = isRecommended && ev?.reason
                    ? `AI: ${cfg.label} — ${ev.reason}`
                    : cfg.label;

                  return (
                    <button
                      key={actionKey}
                      onClick={onClick}
                      disabled={actionInProgress === msg.id}
                      className={`flex items-center p-1.5 rounded text-xs transition-colors cursor-pointer disabled:opacity-50 ${
                        isRecommended
                          ? `${cfg.bg} ${cfg.color} ring-1 ring-current`
                          : 'text-gray-500 hover:text-gray-300 hover:bg-port-border/50'
                      }`}
                      title={title} aria-label={title}
                    >
                      {actionInProgress === msg.id && isActionable
                        ? <Loader2 size={14} className="animate-spin" />
                        : <Icon size={14} />
                      }
                    </button>
                  );
                })}
                <ChevronRight size={16} className="text-gray-600 ml-1" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

