import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Bell, BellOff, Bot, Check, CheckCheck, CheckCircle2, CircleDot, CircleX, ExternalLink, GitCommitHorizontal, GitPullRequest,
  Inbox, Layers, Mail, MailX, MessagesSquare, RefreshCw, Rocket, ShieldAlert, Tag,
} from 'lucide-react';
import Pill from '../ui/Pill';
import OverflowMenu from '../ui/OverflowMenu';
import GitHubThreadDrawer from './GitHubThreadDrawer';
import GitHubDeploymentReview from './GitHubDeploymentReview';
import GitHubAgentPinForm from './GitHubAgentPinForm';
import { AGENT_REFUSED_LABELS, DECISION_ACTIONS, DECISION_VIEW, TRUST_VIEW } from './githubTriageLabels';
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
  applyGitHubNotificationAction,
  resolveGitHubNotificationWithAgent,
} from '../../services/api';

// GitHub's `reason` vocabulary, phrased for a glance.
const REASON_LABELS = {
  approval_requested: 'Deploy approval',
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

const DONE_ACTION = { action: 'done', label: 'Done' };
// Rarer and harder to undo than Done, so they sit in the row's overflow menu.
const MORE_ACTIONS = [
  { action: 'mute', label: 'Mute', icon: BellOff },
  { action: 'unsubscribe', label: 'Unsubscribe', icon: MailX },
];

// Whether a row still belongs in the view after an action moved it. Mirrors
// VIEW_FILTERS in server/services/githubNotifications.js: the inbox holds every
// open thread GitHub still has unread or PortOS has not seen read there,
// whatever its decision.
const VIEW_MATCHERS = {
  'needs-you': (row) => row.state === 'open' && !row.readOnGithub && !row.suspect,
  suspect: (row) => row.state === 'open' && !row.readOnGithub && row.suspect,
  handled: (row) => row.state !== 'open' || row.readOnGithub,
  all: () => true,
};
const belongsInView = (row, view) => VIEW_MATCHERS[view](row);

// The kind of thing a thread is about, as an icon and a word for screen readers.
const KIND_VIEW = {
  PullRequest: { icon: GitPullRequest, label: 'Pull request', className: 'text-port-accent' },
  Issue: { icon: CircleDot, label: 'Issue', className: 'text-port-success' },
  CheckSuite: { icon: CircleX, label: 'CI', className: 'text-port-error' },
  Release: { icon: Tag, label: 'Release', className: 'text-gray-300' },
  Discussion: { icon: MessagesSquare, label: 'Discussion', className: 'text-gray-300' },
  Commit: { icon: GitCommitHorizontal, label: 'Commit', className: 'text-gray-300' },
  RepositoryInvitation: { icon: Mail, label: 'Invitation', className: 'text-gray-300' },
  WorkflowRun: { icon: Rocket, label: 'Workflow run', className: 'text-port-warning' },
};
const SECURITY_KIND = { icon: ShieldAlert, label: 'Security alert', className: 'text-port-error' };
const kindOf = (notification) => (notification.reason === 'security_alert'
  ? SECURITY_KIND
  : KIND_VIEW[notification.subjectType] || { icon: Bell, label: notification.subjectType || 'Notification', className: 'text-gray-400' });

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

// Where an agent run's failure can be read: its agent, else its CoS task.
const agentFailedLink = ({ agentId, taskId }) => (agentId
  ? `/cos/agents/${encodeURIComponent(agentId)}`
  : `/cos/tasks?task=${encodeURIComponent(taskId)}&source=user`);

const SUGGESTION_ICONS = { agent: Bot, done: Check, mute: BellOff };
// A suggestion button keeps its pill's color, so the row still reads the same.
const SUGGESTION_TONES = {
  accent: 'border-port-accent/40 bg-port-accent/10 text-port-accent',
  warning: 'border-port-warning/40 bg-port-warning/10 text-port-warning',
  muted: 'border-port-border bg-port-bg text-gray-200',
};

function NotificationRow({ notification, accountLabel, busy, onAction, onUpdated }) {
  const [reviewing, setReviewing] = useState(false);
  const [picking, setPicking] = useState(false);
  const handled = notification.state !== 'open';
  const trust = TRUST_VIEW[notification.trust];
  const decision = DECISION_VIEW[notification.decision];
  const kind = kindOf(notification);
  // Every open row offers the button; a refused lane disables it with its reason.
  const agent = handled ? null : notification.agent;
  const canResolve = Boolean(agent) && !agent.refused;
  const refusedId = `agent-refused-${notification.accountId}-${notification.threadId}`;
  const suggestionAction = handled ? null : DECISION_ACTIONS[notification.decision];
  const suggestion = suggestionAction ? { ...suggestionAction, icon: SUGGESTION_ICONS[suggestionAction.action] } : null;
  const startAgent = async (pin) => {
    if (await onAction(notification, 'agent', pin)) setPicking(false);
  };
  const overflow = handled ? [] : MORE_ACTIONS.map(({ action, label, icon }) => ({
    id: action, label, icon, disabled: busy, onSelect: () => onAction(notification, action),
  }));
  return (
    <article className="flex min-w-0 gap-3 px-3 py-3 @3xl/page:px-4">
      <span className="relative mt-0.5 shrink-0">
        <kind.icon size={18} className={kind.className} aria-label={kind.label} role="img" />
        {notification.unread && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-port-accent ring-2 ring-port-card" aria-label="Unread" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 @3xl/page:flex-row @3xl/page:items-start">
        <div className="min-w-0 flex-1">
          <Link
            to={`/devtools/github/inbox/${encodeURIComponent(notification.accountId)}/${notification.threadId}`}
            className={`block break-words text-sm hover:underline ${notification.unread ? 'font-semibold text-white' : 'text-gray-200'}`}
          >
            {notification.title}
          </Link>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
            <span className="text-gray-300">{REASON_LABELS[notification.reason] || notification.reason}</span>
            {notification.repoFullName && <span className="min-w-0 truncate font-mono">{notification.repoFullName}</span>}
            <span className="shrink-0">· {timeAgo(notification.updatedAt)}</span>
            {accountLabel && <span className="shrink-0">· {accountLabel}</span>}
          </div>
          {notification.deployment && (
            <p className="mt-1 min-w-0 break-words text-xs text-gray-300">
              <span className="text-white">{notification.deployment.name}</span>
              {notification.deployment.headBranch && <> on <span className="font-mono">{notification.deployment.headBranch}</span></>}
              {notification.deployment.displayTitle && <> · {notification.deployment.displayTitle}</>}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {decision && (suggestion ? (
              <button
                type="button"
                disabled={busy || (suggestion.action === 'agent' && !canResolve)}
                onClick={() => (suggestion.action === 'agent' ? setPicking(true) : onAction(notification, suggestion.action))}
                aria-describedby={suggestion.action === 'agent' && agent?.refused ? refusedId : undefined}
                className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium hover:brightness-125 disabled:opacity-50 ${SUGGESTION_TONES[decision.tone] || SUGGESTION_TONES.muted}`}
              >
                <suggestion.icon size={12} aria-hidden="true" /> {suggestion.label}
              </button>
            ) : <Pill tone={decision.tone}>{decision.label}</Pill>)}
            {notification.yourRepo && <Pill tone="accent">Your repo</Pill>}
            {notification.repoPrivate && <Pill tone="muted">Private</Pill>}
            {trust && <Pill tone={trust.tone}>{trust.label}</Pill>}
            {notification.readOnGithub && <Pill tone="muted">Read on GitHub</Pill>}
            {handled && <Pill tone="muted">{STATE_LABELS[notification.state] || notification.state}</Pill>}
            {!handled && notification.agentFailed && (
              <Link to={agentFailedLink(notification.agentFailed)} className="rounded hover:underline">
                <Pill tone="error">Agent failed</Pill>
              </Link>
            )}
          </div>
          {reviewing && (
            <GitHubDeploymentReview
              notification={notification}
              onCancel={() => setReviewing(false)}
              onReviewed={(updated) => { setReviewing(false); onUpdated(notification, updated); }}
            />
          )}
          {picking && canResolve && (
            <GitHubAgentPinForm
              pin={agent.pin}
              label={`Agent for ${notification.title}`}
              submitLabel={busy ? 'Starting…' : 'Start agent'}
              busy={busy}
              onSubmit={startAgent}
              onCancel={() => setPicking(false)}
            />
          )}
          {agent?.refused && (
            <p id={refusedId} className="mt-1 text-xs text-gray-500">
              {AGENT_REFUSED_LABELS[agent.refused] || agent.refused}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {!handled && notification.deployment && !reviewing && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setReviewing(true)}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg bg-port-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              <Rocket size={13} aria-hidden="true" /> Review deployment
            </button>
          )}
          {agent && !picking && (
            <button
              type="button"
              disabled={busy || !canResolve}
              onClick={() => setPicking(true)}
              aria-describedby={agent.refused ? refusedId : undefined}
              className={`inline-flex min-h-[36px] items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${canResolve
                ? 'bg-port-accent text-white'
                : 'border border-port-border text-gray-400'}`}
            >
              <Bot size={13} aria-hidden="true" /> Resolve with agent
            </button>
          )}
          {(handled ? [UNDO_ACTIONS[notification.state]].filter(Boolean) : [DONE_ACTION]).map(({ action, label }) => (
            <button
              key={action}
              type="button"
              disabled={busy}
              onClick={() => onAction(notification, action)}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-port-border px-3 py-1.5 text-xs text-gray-200 hover:border-gray-500 disabled:opacity-50"
            >
              {action === 'done' && <Check size={13} aria-hidden="true" />}
              {label}
            </button>
          ))}
          {notification.htmlUrl && (
            <a
              href={notification.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-port-border px-3 py-1.5 text-xs text-gray-300 hover:border-gray-500"
            >
              <ExternalLink size={12} aria-hidden="true" /> Open
            </a>
          )}
          {overflow.length > 0 && <OverflowMenu label={`More actions for ${notification.title}`} items={overflow} />}
        </div>
      </div>
    </article>
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
  const [busyKey, setBusyKey] = useState(null);
  const [clearing, setClearing] = useState(false);
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

  // Resolves true once the server took the action. `run` is the agent picker's
  // provider/model/effort for Resolve with agent.
  const handleAction = async (row, action, run) => {
    const key = keyOf(row);
    setBusyKey(key);
    const updated = await (action === 'agent'
      ? resolveGitHubNotificationWithAgent(row.accountId, row.threadId, run)
      : applyGitHubNotificationAction(row.accountId, row.threadId, action)).catch(() => null);
    setBusyKey(null);
    if (updated) applyUpdate(row, updated);
    return Boolean(updated);
  };

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

  const enabledAccounts = (accounts || []).filter((account) => account.enabled);
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
      {(data.counts?.['with-agents'] > 0 || (view === 'needs-you' && data.counts?.finished > 0)) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {data.counts['with-agents'] > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-gray-400">
              <Bot size={13} className="text-port-accent" aria-hidden="true" />
              {formatCount(data.counts['with-agents'])} with an agent now
            </p>
          )}
          {view === 'needs-you' && data.counts.finished > 0 && (
            <button
              type="button"
              onClick={clearFinished}
              disabled={clearing}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-port-border bg-port-card px-3 py-1.5 text-xs text-gray-200 hover:border-gray-500 disabled:opacity-60"
            >
              <CheckCheck size={13} aria-hidden="true" />
              {clearing ? 'Marking done…' : `Mark ${formatCount(data.counts.finished)} finished done`}
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
                    <NotificationRow
                      notification={notification}
                      accountLabel={labelFor(notification.accountId)}
                      busy={busyKey === key || removing.has(key)}
                      onAction={handleAction}
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
