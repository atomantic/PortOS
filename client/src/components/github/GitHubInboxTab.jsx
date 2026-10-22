import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import Pill from '../ui/Pill';
import LoadFailedState from '../ui/LoadFailedState';
import PageSkeleton from '../ui/PageSkeleton';
import CollapsibleListItem from '../ui/CollapsibleListItem';
import { timeAgo } from '../../utils/formatters';
import {
  getGitHubAccounts,
  getGitHubNotifications,
  syncGitHubNotifications,
  applyGitHubNotificationAction,
} from '../../services/api';

const VIEWS = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'handled', label: 'Handled' },
  { id: 'all', label: 'All' },
];

// GitHub's `reason` vocabulary, phrased for a glance.
const REASON_LABELS = {
  assign: 'Assigned',
  author: 'You opened',
  ci_activity: 'CI',
  comment: 'Comment',
  invitation: 'Invitation',
  manual: 'Subscribed',
  mention: 'Mention',
  review_requested: 'Review requested',
  security_alert: 'Security alert',
  state_change: 'State change',
  subscribed: 'Watching',
  team_mention: 'Team mention',
};

const STATE_LABELS = { done: 'Done', muted: 'Muted', unsubscribed: 'Unsubscribed' };

// Undoing Done is local; undoing Mute/Unsubscribe re-subscribes on GitHub.
const UNDO_ACTIONS = {
  done: { action: 'reopen', label: 'Back to inbox' },
  muted: { action: 'resubscribe', label: 'Unmute' },
  unsubscribed: { action: 'resubscribe', label: 'Resubscribe' },
};

const OPEN_ACTIONS = [
  { action: 'done', label: 'Done' },
  { action: 'mute', label: 'Mute' },
  { action: 'unsubscribe', label: 'Unsubscribe' },
];

const chipClass = (active) => `shrink-0 rounded-full border px-3 py-1.5 text-xs ${active
  ? 'border-port-accent/40 bg-port-accent/20 text-port-accent'
  : 'border-port-border bg-port-bg text-gray-400'}`;

// Whether a row still belongs in the view after an action moved it.
const belongsInView = (row, view) => view === 'all' || (view === 'needs-you') === (row.state === 'open');

function NotificationCard({ notification, accountLabel, busy, onAction }) {
  const handled = notification.state !== 'open';
  return (
    <article className="min-w-0 rounded-lg border border-port-border bg-port-card p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        {notification.unread && <span className="h-2 w-2 shrink-0 rounded-full bg-port-accent" aria-label="Unread" />}
        <span className="font-medium text-gray-300">{REASON_LABELS[notification.reason] || notification.reason}</span>
        <span className="min-w-0 truncate font-mono">{notification.repoFullName}</span>
        {notification.yourRepo && <Pill tone="accent">Your repo</Pill>}
        {notification.repoPrivate && <Pill tone="muted">Private</Pill>}
        {handled && <Pill tone="muted">{STATE_LABELS[notification.state] || notification.state}</Pill>}
        <span className="ml-auto shrink-0">{timeAgo(notification.updatedAt)}</span>
      </div>
      <p className="mt-1.5 break-words text-sm text-white">{notification.title}</p>
      {accountLabel && <p className="mt-0.5 text-xs text-gray-500">{accountLabel}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {notification.htmlUrl && (
          <a
            href={notification.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded border border-port-border px-3 py-1.5 text-xs text-gray-300"
          >
            <ExternalLink size={12} aria-hidden="true" /> Open
          </a>
        )}
        {(handled ? [UNDO_ACTIONS[notification.state]].filter(Boolean) : OPEN_ACTIONS).map(({ action, label }) => (
          <button
            key={action}
            type="button"
            disabled={busy}
            onClick={() => onAction(notification, action)}
            className="rounded border border-port-border px-3 py-1.5 text-xs text-gray-300 disabled:opacity-50"
          >
            {label}
          </button>
        ))}
      </div>
    </article>
  );
}

export default function GitHubInboxTab() {
  const [accounts, setAccounts] = useState(null);
  const [accountId, setAccountId] = useState(null);
  const [view, setView] = useState('needs-you');
  const [data, setData] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const [removing, setRemoving] = useState(() => new Set());
  const [syncTick, setSyncTick] = useState(0);
  const requestRef = useRef(0);

  const keyOf = (row) => `${row.accountId}/${row.threadId}`;

  const loadList = useCallback(async () => {
    const requestId = ++requestRef.current;
    const result = await getGitHubNotifications({ accountId, view }, { silent: true }).catch(() => null);
    if (requestId !== requestRef.current) return;
    if (!result) {
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    setRemoving(new Set());
    setData(result);
  }, [accountId, view]);

  const refresh = useCallback(async () => {
    setSyncing(true);
    // Per-account failures come back in the results and are shown from the
    // stored sync state, so this never toasts.
    await syncGitHubNotifications(accountId, { silent: true }).catch(() => null);
    setSyncing(false);
    setSyncTick((tick) => tick + 1);
  }, [accountId]);

  useEffect(() => {
    // Accounts only label rows and add a filter; without them the inbox still works.
    getGitHubAccounts({ silent: true }).then(setAccounts).catch(() => {});
  }, []);

  // Stored rows show at once; each finished sync re-reads them.
  useEffect(() => { loadList(); }, [loadList, syncTick]);
  useEffect(() => { refresh(); }, [refresh]);

  const handleAction = async (row, action) => {
    const key = keyOf(row);
    setBusyKey(key);
    const updated = await applyGitHubNotificationAction(row.accountId, row.threadId, action).catch(() => null);
    setBusyKey(null);
    if (!updated) return;
    if (belongsInView(updated, view)) {
      setData((prev) => ({ ...prev, notifications: prev.notifications.map((entry) => (keyOf(entry) === key ? updated : entry)) }));
    } else {
      setRemoving((prev) => new Set(prev).add(key));
    }
  };

  const dropRow = (key) => {
    setData((prev) => ({ ...prev, notifications: prev.notifications.filter((entry) => keyOf(entry) !== key) }));
    setRemoving((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const enabledAccounts = (accounts || []).filter((account) => account.enabled);
  const labelFor = (id) => (enabledAccounts.length > 1 ? accounts.find((account) => account.id === id)?.label : null);
  const syncErrors = Object.entries(data?.sync || {}).filter(([id, state]) => state.lastError && (!accountId || id === accountId));
  const lastSyncAt = Object.values(data?.sync || {}).map((state) => state.lastSyncAt).filter(Boolean).sort().at(-1);

  if (loadFailed && !data) return <LoadFailedState title="Could not load GitHub notifications." hint="Retry the local inbox read." onRetry={loadList} />;
  if (!data) return <PageSkeleton label="Loading GitHub notifications" titleWidthClass="w-40" showAction={false} cards={3} />;

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto" role="group" aria-label="Inbox view">
          {VIEWS.map((entry) => (
            <button key={entry.id} type="button" aria-pressed={view === entry.id} onClick={() => setView(entry.id)} className={chipClass(view === entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={syncing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-port-border px-3 py-1.5 text-xs text-gray-300 disabled:opacity-60"
        >
          <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} aria-hidden="true" />
          {syncing ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {enabledAccounts.length > 1 && (
        <div className="flex gap-2 overflow-x-auto" role="group" aria-label="Account">
          <button type="button" aria-pressed={!accountId} onClick={() => setAccountId(null)} className={chipClass(!accountId)}>All accounts</button>
          {enabledAccounts.map((account) => (
            <button key={account.id} type="button" aria-pressed={accountId === account.id} onClick={() => setAccountId(account.id)} className={chipClass(accountId === account.id)}>
              {account.label}
            </button>
          ))}
        </div>
      )}

      {syncErrors.map(([id, state]) => (
        <p key={id} role="alert" className="rounded border border-port-error/40 bg-port-error/10 p-2 text-xs text-port-error break-words">
          {accounts?.find((account) => account.id === id)?.label || id}: {state.lastError}
        </p>
      ))}

      {data.notifications.length === 0 ? (
        <p className="rounded-lg border border-port-border bg-port-card p-4 text-sm text-gray-400">
          {view === 'needs-you' ? 'Nothing needs you right now.' : 'No notifications here.'}
        </p>
      ) : (
        <div className="min-w-0">
          {data.notifications.map((notification) => {
            const key = keyOf(notification);
            return (
              <CollapsibleListItem key={key} removing={removing.has(key)} onExited={() => dropRow(key)}>
                <NotificationCard
                  notification={notification}
                  accountLabel={labelFor(notification.accountId)}
                  busy={busyKey === key || removing.has(key)}
                  onAction={handleAction}
                />
              </CollapsibleListItem>
            );
          })}
        </div>
      )}

      {lastSyncAt && <p className="text-xs text-gray-500">Checked {timeAgo(lastSyncAt)}</p>}
    </div>
  );
}
