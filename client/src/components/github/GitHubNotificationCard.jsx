import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Bell, BellOff, Bot, Check, CheckCircle2, CircleDot, CircleX, ExternalLink,
  GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft,
  ListPlus, Mail, MailX, MessagesSquare, Rocket, ShieldAlert, Tag,
} from 'lucide-react';
import Pill from '../ui/Pill';
import OverflowMenu from '../ui/OverflowMenu';
import GitHubDeploymentReview from './GitHubDeploymentReview';
import GitHubAgentPinForm from './GitHubAgentPinForm';
import GitHubPullRequestActions from './GitHubPullRequestActions';
import { AGENT_REFUSED_LABELS, DECISION_ACTIONS, DECISION_VIEW, REASON_WHY, TONE_EDGE, TRUST_VIEW, subjectStatusChip } from './githubTriageLabels';
import { timeAgo } from '../../utils/formatters';
import { applyGitHubNotificationAction, resolveGitHubNotificationWithAgent } from '../../services/api';

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
// A PR or issue's icon and color follow its state, as on GitHub: green open,
// gray draft, purple merged or resolved, red closed.
const STATE_KIND = {
  PullRequest: {
    merged: { icon: GitMerge, label: 'Merged pull request', className: 'text-purple-400' },
    closed: { icon: GitPullRequestClosed, label: 'Closed pull request', className: 'text-port-error' },
    draft: { icon: GitPullRequestDraft, label: 'Draft pull request', className: 'text-gray-400' },
    open: { icon: GitPullRequest, label: 'Open pull request', className: 'text-port-success' },
  },
  Issue: {
    merged: { icon: CheckCircle2, label: 'Resolved issue', className: 'text-purple-400' },
    closed: { icon: CheckCircle2, label: 'Closed issue', className: 'text-purple-400' },
    open: { icon: CircleDot, label: 'Open issue', className: 'text-port-success' },
  },
};
const kindOf = (notification) => {
  if (notification.reason === 'security_alert') return SECURITY_KIND;
  const status = notification.subjectStatus;
  const byState = STATE_KIND[notification.subjectType];
  if (byState && status?.state) {
    return byState[status.state === 'open' && status.draft ? 'draft' : status.state] || byState.open;
  }
  return KIND_VIEW[notification.subjectType] || { icon: Bell, label: notification.subjectType || 'Notification', className: 'text-gray-400' };
};

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

// The Automations tab's rule form, prefilled with this thread's kind and repo.
const automationRuleLink = (notification) => {
  const params = new URLSearchParams({ ruleAccount: notification.accountId, ruleKind: notification.ruleKind });
  if (notification.repoFullName) params.set('ruleRepo', notification.repoFullName);
  return `/devtools/github/automations?${params}`;
};

/** The same source-owned controls in the GitHub inbox and central Actions queue. */
export default function GitHubNotificationCard({ notification: sourceNotification, accountLabel, busy: disabled = false, onUpdated, detailTo }) {
  const [localUpdate, setLocalUpdate] = useState(null);
  const notification = localUpdate?.source === sourceNotification ? localUpdate.notification : sourceNotification;
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const busy = disabled || pending;
  const refusedId = useId();
  const applyUpdate = (row, updated) => {
    setLocalUpdate({ source: sourceNotification, notification: updated });
    onUpdated?.(row, updated);
  };
  const onAction = async (row, action, run) => {
    if (disabled || inFlight.current) return false;
    inFlight.current = true;
    setPending(true);
    const updated = await (action === 'agent'
      ? resolveGitHubNotificationWithAgent(row.accountId, row.threadId, run)
      : applyGitHubNotificationAction(row.accountId, row.threadId, action)).catch(() => null);
    inFlight.current = false;
    setPending(false);
    if (updated) applyUpdate(row, updated);
    return Boolean(updated);
  };
  const [reviewing, setReviewing] = useState(false);
  const [picking, setPicking] = useState(false);
  const handled = notification.state !== 'open';
  const trust = TRUST_VIEW[notification.trust];
  const decision = DECISION_VIEW[notification.decision];
  const kind = kindOf(notification);
  const why = REASON_WHY[notification.reason];
  const statusChip = subjectStatusChip(notification.subjectType, notification.subjectStatus);
  // Every open row offers the button; a refused lane disables it with its reason.
  const agent = handled ? null : notification.agent;
  const canResolve = Boolean(agent) && !agent.refused;
  const suggestionAction = handled || notification.pullRequest ? null : DECISION_ACTIONS[notification.decision];
  const suggestion = suggestionAction ? { ...suggestionAction, icon: SUGGESTION_ICONS[suggestionAction.action] } : null;
  const startAgent = async (pin) => {
    if (await onAction(notification, 'agent', pin)) setPicking(false);
  };
  const overflow = [
    ...(handled ? [] : MORE_ACTIONS.map(({ action, label, icon }) => ({
      id: action, label, icon, disabled: busy, onSelect: () => onAction(notification, action),
    }))),
    // Handle every similar thread the same way from now on (#13192).
    ...(notification.ruleKind ? [{ id: 'add-rule', label: 'Add automation rule…', icon: ListPlus, to: automationRuleLink(notification) }] : []),
  ];
  return (
    <article className={`flex min-w-0 gap-3 border-l-4 px-3 py-3 @3xl/page:px-4 ${TONE_EDGE[handled ? 'muted' : why?.tone] || TONE_EDGE.muted}`}>
      <span className="relative mt-0.5 shrink-0">
        <kind.icon size={18} className={kind.className} aria-label={kind.label} role="img" />
        {notification.unread && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-port-accent ring-2 ring-port-card" aria-label="Unread" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 @3xl/page:grid @3xl/page:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] @3xl/page:items-start">
        <div className="min-w-0 flex-1">
          <Link
            to={detailTo || `/devtools/github/inbox/${encodeURIComponent(notification.accountId)}/${notification.threadId}`}
            className={`block break-words text-sm hover:underline ${notification.unread ? 'font-semibold text-white' : 'text-gray-200'}`}
          >
            {notification.title}
          </Link>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
            <Pill tone={why?.tone || 'muted'} size="xs">{REASON_LABELS[notification.reason] || notification.reason}</Pill>
            {statusChip && <Pill tone={statusChip.tone} size="xs">{statusChip.label}</Pill>}
            {notification.repoFullName && <span className="min-w-0 truncate font-mono">{notification.repoFullName}</span>}
            <span className="shrink-0">· {timeAgo(notification.updatedAt)}</span>
            {accountLabel && <span className="shrink-0">· {accountLabel}</span>}
          </div>
          {why && <p className="mt-1 text-xs text-gray-400">{why.text}</p>}
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
            {notification.state === 'open' && !notification.unread && <Pill tone="muted">{notification.readOnGithub ? 'Read on GitHub' : 'Read'}</Pill>}
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
              onReviewed={(updated) => { setReviewing(false); applyUpdate(notification, updated); }}
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
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
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
          {notification.pullRequest && <GitHubPullRequestActions notification={notification} onUpdated={applyUpdate} />}
          {agent && !picking && !notification.pullRequest && (
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

