import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { Bot, CheckCheck, CheckCircle2, Inbox, Layers, RefreshCw, ShieldAlert } from 'lucide-react';
import GitHubThreadDrawer from './GitHubThreadDrawer';
import GitHubNotificationCard from './GitHubNotificationCard';
import socket from '../../services/socket';
import LoadFailedState from '../ui/LoadFailedState';
import PageSkeleton from '../ui/PageSkeleton';
import CollapsibleListItem from '../ui/CollapsibleListItem';
import { formatCount, timeAgo } from '../../utils/formatters';
import {
  clearFinishedGitHubNotifications,
  getGitHubAccounts,
  getGitHubNotifications,
  syncGitHubNotifications,
} from '../../services/api';

// Whether a row still belongs in the view after an action moved it. Mirrors
// VIEW_FILTERS in server/services/githubNotifications.js: the inbox holds
// unread open threads, whatever their decision.
const VIEW_MATCHERS = {
  'needs-you': (row) => row.state === 'open' && row.unread && !row.readOnGithub && !row.suspect,
  suspect: (row) => row.state === 'open' && row.unread && !row.readOnGithub && row.suspect,
  handled: (row) => row.state !== 'open' || !row.unread || row.readOnGithub,
  all: () => true,
};
const belongsInView = (row, view) => VIEW_MATCHERS[view](row);

// Summary tiles double as the view picker. Counts come from the server for
// every view at once; tone follows meaning, and every tile also has a label.
const TILES = [
  { id: 'needs-you', label: 'Inbox', icon: Inbox, iconClass: 'text-port-accent' },
  { id: 'suspect', label: 'Suspect', icon: ShieldAlert, iconClass: 'text-port-warning' },
  { id: 'handled', label: 'Handled', icon: CheckCircle2, iconClass: 'text-port-success' },
  { id: 'all', label: 'All', icon: Layers, iconClass: 'text-gray-400' },
];

function SummaryTiles({ view, counts, onSelect }) {
  return (
    <div className="grid grid-cols-2 gap-2 @3xl/page:grid-cols-4" role="group" aria-label="Inbox view">
      {TILES.map((tile) => {
        const active = view === tile.id;
        const count = counts?.[tile.id];
        return (
          <button
            key={tile.id}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(tile.id)}
            className={`min-w-0 rounded-xl border p-3 text-left transition-colors ${active
              ? 'border-port-accent/60 bg-port-accent/10'
              : 'border-port-border bg-port-card hover:border-port-accent/30'}`}
          >
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <tile.icon size={14} className={tile.iconClass} aria-hidden="true" />
              {tile.label}
            </span>
            <span className="mt-1 block text-2xl font-semibold tabular-nums text-white">{formatCount(count)}</span>
          </button>
        );
      })}
    </div>
  );
}

function RepoFilter({ repos, repo, onSelect, total }) {
  const item = (value, label, count) => {
    const active = repo === value;
    return (
      <li key={value ?? '*'}>
        <button
          type="button"
          aria-pressed={active}
          onClick={() => onSelect(value)}
          className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${active ? 'bg-port-accent/15 text-white' : 'text-gray-400 hover:bg-port-card hover:text-gray-200'}`}
        >
          <span className={`min-w-0 flex-1 truncate ${value ? 'font-mono' : ''}`}>{label}</span>
          <span className="shrink-0 tabular-nums text-gray-500">{formatCount(count)}</span>
        </button>
      </li>
    );
  };
  return (
    <nav aria-label="Repositories" className="min-w-0">
      <h2 className="mb-1 px-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500">Repositories</h2>
      <ul className="space-y-0.5">
        {item(null, 'All repositories', total)}
        {repos.map(([name, count]) => item(name, name || 'Advisories', count))}
      </ul>
    </nav>
  );
}

export default function GitHubInboxTab() {
  const { accountId: routeAccountId, threadId } = useParams();
  const [accounts, setAccounts] = useState(null);
  const [accountId, setAccountId] = useState(null);
  const [view, setView] = useState('needs-you');
  const [repo, setRepo] = useState(null);
  const [data, setData] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [removing, setRemoving] = useState(() => new Set());
  const [syncTick, setSyncTick] = useState(0);
  const requestRef = useRef(0);
  const syncRequestRef = useRef(0);

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
    const request = ++syncRequestRef.current;
    setSyncing(true);
    // Per-account failures come back in the results and are shown from the
    // stored sync state, so this never toasts.
    await syncGitHubNotifications(accountId, { silent: true }).catch(() => null);
    // A newer sync (account switched mid-check) owns the spinner and the reload.
    if (request !== syncRequestRef.current) return;
    setSyncing(false);
    setSyncTick((tick) => tick + 1);
  }, [accountId]);

  useEffect(() => {
    // Accounts only label rows and add a filter; without them the inbox still works.
    getGitHubAccounts({ silent: true }).then(setAccounts).catch(() => {});
  }, []);

  // Stored rows show at once; each finished sync, and every server-side change
  // (a scheduled check, an action from another tab), re-reads them.
  useEffect(() => { loadList(); }, [loadList, syncTick]);
  useEffect(() => {
    const reload = () => setSyncTick((tick) => tick + 1);
    socket.on('github:notifications:changed', reload);
    socket.on('connect', reload);
    return () => {
      socket.off('github:notifications:changed', reload);
      socket.off('connect', reload);
    };
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const applyUpdate = (row, updated) => {
    const key = keyOf(row);
    if (belongsInView(updated, view)) {
      setData((prev) => ({ ...prev, notifications: prev.notifications.map((entry) => (keyOf(entry) === key ? updated : entry)) }));
    } else {
      setRemoving((prev) => new Set(prev).add(key));
    }
  };

  // The server's changed event re-reads the list once the batch is done.
  const clearFinished = async () => {
    setClearing(true);
    await clearFinishedGitHubNotifications(accountId).catch(() => null);
    setClearing(false);
  };

  const dropRow = (key) => {
    setData((prev) => ({ ...prev, notifications: prev.notifications.filter((entry) => keyOf(entry) !== key) }));
    setRemoving((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const enabledAccounts = (accounts || []).filter((account) => account.enabled && account.mode !== 'disabled');
  const labelFor = (id) => (enabledAccounts.length > 1 ? accounts.find((account) => account.id === id)?.label : null);
  const syncErrors = Object.entries(data?.sync || {}).filter(([id, state]) => state.lastError && (!accountId || id === accountId));
  const lastSyncAt = Object.values(data?.sync || {}).map((state) => state.lastSyncAt).filter(Boolean).sort().at(-1);

  if (loadFailed && !data) return <LoadFailedState title="Could not load GitHub notifications." hint="Retry the local inbox read." onRetry={loadList} />;
  if (!data) return <PageSkeleton label="Loading GitHub notifications" titleWidthClass="w-40" showAction={false} cards={3} />;

  const rows = data.notifications;
  // The repo list is built from the loaded view, so it always matches the rows.
  const repoCounts = [...rows.reduce((map, row) => map.set(row.repoFullName, (map.get(row.repoFullName) || 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const activeRepo = repo !== null && repoCounts.some(([name]) => name === repo) ? repo : null;
  const shown = activeRepo === null ? rows : rows.filter((row) => row.repoFullName === activeRepo);
  const repoSelectId = 'github-inbox-repo';

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {enabledAccounts.length > 1 && (
          <>
            <label htmlFor="github-inbox-account" className="sr-only">Account</label>
            <select
              id="github-inbox-account"
              value={accountId || ''}
              onChange={(event) => setAccountId(event.target.value || null)}
              className="rounded-lg border border-port-border bg-port-card px-2.5 py-1.5 text-xs text-white"
            >
              <option value="">All accounts</option>
              {enabledAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
            </select>
          </>
        )}
        <span className="text-xs text-gray-500">{lastSyncAt ? `Checked ${timeAgo(lastSyncAt)}` : 'Not checked yet'}</span>
        <button
          type="button"
          onClick={refresh}
          disabled={syncing}
          className="ml-auto inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-lg border border-port-border bg-port-card px-3 py-1.5 text-xs text-gray-200 disabled:opacity-60"
        >
          <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} aria-hidden="true" />
          {syncing ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      <SummaryTiles view={view} counts={data.counts} onSelect={setView} />
      {(data.counts?.['with-agents'] > 0 || (view === 'needs-you' && data.counts?.clearable > 0)) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {data.counts['with-agents'] > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-gray-400">
              <Bot size={13} className="text-port-accent" aria-hidden="true" />
              {formatCount(data.counts['with-agents'])} with an agent now
            </p>
          )}
          {view === 'needs-you' && data.counts.clearable > 0 && (
            <button
              type="button"
              onClick={clearFinished}
              disabled={clearing}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-port-border bg-port-card px-3 py-1.5 text-xs text-gray-200 hover:border-gray-500 disabled:opacity-60"
            >
              <CheckCheck size={13} aria-hidden="true" />
              {clearing ? 'Marking done…' : `Mark ${formatCount(data.counts.clearable)} finished or read done`}
            </button>
          )}
        </div>
      )}

      {syncErrors.map(([id, state]) => (
        <p key={id} role="alert" className="rounded-lg border border-port-error/40 bg-port-error/10 p-2 text-xs text-port-error break-words">
          {accounts?.find((account) => account.id === id)?.label || id}: {state.lastError}
        </p>
      ))}

      <div className="grid min-w-0 grid-cols-1 gap-4 @5xl/page:grid-cols-[15rem_minmax(0,1fr)]">
        {repoCounts.length > 1 && (
          <>
            <div className="hidden @5xl/page:block">
              <RepoFilter repos={repoCounts} repo={activeRepo} onSelect={setRepo} total={rows.length} />
            </div>
            <div className="@5xl/page:hidden">
              <label htmlFor={repoSelectId} className="sr-only">Repository</label>
              <select
                id={repoSelectId}
                value={activeRepo ?? '*'}
                onChange={(event) => setRepo(event.target.value === '*' ? null : event.target.value)}
                className="w-full rounded-lg border border-port-border bg-port-card px-2.5 py-2 text-sm text-white"
              >
                <option value="*">All repositories ({formatCount(rows.length)})</option>
                {repoCounts.map(([name, count]) => <option key={name} value={name}>{name || 'Advisories'} ({formatCount(count)})</option>)}
              </select>
            </div>
          </>
        )}
        <section
          aria-label="Notifications"
          className={`min-w-0 overflow-hidden rounded-xl border border-port-border bg-port-card ${repoCounts.length > 1 ? '' : '@5xl/page:col-span-2'}`}
        >
          {shown.length === 0 ? (
            <p className="p-6 text-center text-sm text-gray-400">
              {{ 'needs-you': 'Your inbox is clear.', suspect: 'Nothing suspicious.' }[view] || 'No notifications here.'}
            </p>
          ) : (
            <div className="min-w-0 divide-y divide-port-border">
              {shown.map((notification) => {
                const key = keyOf(notification);
                return (
                  <CollapsibleListItem key={key} removing={removing.has(key)} onExited={() => dropRow(key)}>
                    <GitHubNotificationCard
                      notification={notification}
                      accountLabel={labelFor(notification.accountId)}
                      busy={removing.has(key)}
                      onUpdated={applyUpdate}
                    />
                  </CollapsibleListItem>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {threadId && routeAccountId && (
        <GitHubThreadDrawer accountId={routeAccountId} threadId={threadId} />
      )}
    </div>
  );
}
