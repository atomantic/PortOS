import { useState, useEffect } from 'react';
import {
  AlertTriangle,
  Check,
  X,
  Crown,
  Eye,
  Clock3,
  Inbox,
  ArrowRight,
  Brain as BrainIcon,
  MessageCircle,
  Mail,
  Activity,
  DatabaseBackup,
  ListTodo,
  History as HistoryIcon,
  ExternalLink
} from 'lucide-react';
import QueueInvestigationButton from '../ui/QueueInvestigationButton';
import AgentCard from '../cos/tabs/AgentCard';
import HarnessUpdateControl from './HarnessUpdateControl';
import GitHubNotificationCard from '../github/GitHubNotificationCard';
import { timeAgo, formatCount } from '../../utils/formatters';
import * as api from '../../services/api';

// Cross-domain queue source → icon + accent (M42 P5 inbox-zero aggregator).
const QUEUE_SOURCE_CONFIG = {
  brain: { icon: BrainIcon, color: 'text-port-accent-2' },
  ask: { icon: MessageCircle, color: 'text-port-accent' },
  cos: { icon: Crown, color: 'text-port-accent' },
  drafts: { icon: Mail, color: 'text-port-accent' },
  feedback: { icon: MessageCircle, color: 'text-port-warning' },
  health: { icon: Activity, color: 'text-port-warning' },
  updates: { icon: AlertTriangle, color: 'text-port-warning' },
  backup: { icon: DatabaseBackup, color: 'text-port-error' },
  threads: { icon: BrainIcon, color: 'text-port-accent-2' },
  todo: { icon: ListTodo, color: 'text-port-success' },
  history: { icon: HistoryIcon, color: 'text-gray-400' },
};

const QUEUE_SEVERITY_STYLE = {
  critical: 'border-port-error/40',
  high: 'border-port-warning/40',
  normal: 'border-port-border'
};

// Priority badge tint for CoS rows so HIGH/MEDIUM/LOW read at a glance.
const QUEUE_PRIORITY_STYLE = {
  HIGH: 'text-port-error border-port-error/30 bg-port-error/10',
  MEDIUM: 'text-port-warning border-port-warning/30 bg-port-warning/10',
  LOW: 'text-gray-400 border-gray-500/30 bg-gray-500/10'
};

const INLINE_RESOLUTION_OPERATIONS = new Set(['resolve', 'approve', 'reject', 'complete', 'reopen', 'rate']);

const QUEUE_SNOOZE_OPTIONS = [
  { value: 60 * 60 * 1000, label: '1 hour' },
  { value: 24 * 60 * 60 * 1000, label: '1 day' },
  { value: 7 * 24 * 60 * 60 * 1000, label: '1 week' },
];

// Promote-target label for the Ask picker buttons.
const PROMOTE_TARGET_LABEL = { brain: 'Brain', task: 'Task', goal: 'Goal' };

export const isInlineResolution = (operation) => operation?.available !== false && INLINE_RESOLUTION_OPERATIONS.has(operation?.id);

export const safeExternalHttpUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

// Render the source-appropriate triage chips from item.meta. Each field is
// optional — the server omits it when the underlying record lacks it, so we
// only render the chips that are present (no fabricated values).
function QueueMetaChips({ meta }) {
  if (!meta) return null;
  const chips = [];
  if (meta.priority) {
    chips.push(
      <span key="priority" className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${QUEUE_PRIORITY_STYLE[meta.priority] || QUEUE_PRIORITY_STYLE.LOW}`}>
        {meta.priority}
      </span>
    );
  }
  if (typeof meta.turnCount === 'number') {
    chips.push(
      <span key="turns" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        {formatCount(meta.turnCount)} turn{meta.turnCount === 1 ? '' : 's'}
      </span>
    );
  }
  if (meta.recipient) {
    chips.push(
      <span key="recipient" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400 max-w-[12rem] truncate" title={meta.recipient}>
        → {meta.recipient}
      </span>
    );
  }
  if (meta.channel) {
    chips.push(
      <span key="channel" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        {meta.channel}
      </span>
    );
  }
  if (meta.captureSource) {
    chips.push(
      <span key="capture" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        {meta.captureSource}
      </span>
    );
  }
  if (typeof meta.appLabel === 'string' && meta.appLabel) {
    chips.push(
      <span key="app" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400 max-w-[14rem] truncate" title={meta.appLabel}>
        App: {meta.appLabel}
      </span>
    );
  }
  if (typeof meta.taskStatus === 'string' && meta.taskStatus) {
    const blocked = meta.taskStatus === 'blocked';
    chips.push(
      <span key="task-status" className={`text-[10px] px-1.5 py-0.5 rounded border ${blocked ? 'border-port-warning/30 bg-port-warning/10 text-port-warning' : 'border-port-border text-gray-400'}`}>
        Task: {meta.taskStatus}
      </span>
    );
  }
  if (typeof meta.blockedCategory === 'string' && meta.blockedCategory) {
    chips.push(
      <span key="blocked-category" className="text-[10px] px-1.5 py-0.5 rounded border border-port-warning/30 text-port-warning">
        Block: {meta.blockedCategory}
      </span>
    );
  }
  if (meta.alertType) {
    chips.push(
      <span key="alert" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        {meta.alertType}
      </span>
    );
  }
  if (meta.localStatus) {
    chips.push(
      <span key="local-status" className="text-[10px] px-1.5 py-0.5 rounded border border-port-accent/30 text-port-accent">
        local: {meta.localStatus}
      </span>
    );
  }
  if (meta.externalState) {
    chips.push(
      <span key="external-state" className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400">
        external: {meta.externalState}
      </span>
    );
  }
  if (!chips.length) return null;
  return <div className="flex items-center gap-1.5 flex-wrap mt-1">{chips}</div>;
}

export function AgentFeedbackReview({ item, onSaved }) {
  const [agent, setAgent] = useState(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setAgent(null);
    setError(false);
    api.getCosAgent(item.sourceRef, { lines: 1, silent: true })
      .then((record) => { if (active) setAgent(record); })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [item.sourceRef, attempt]);

  if (error) return <p role="alert">Could not load this agent run. <button type="button" className="underline min-h-[44px]" onClick={() => setAttempt(value => value + 1)}>Retry</button></p>;
  if (!agent) return <p role="status">Loading agent run…</p>;
  return <AgentCard agent={agent} completed initiallyExpanded onFeedbackChange={onSaved} />;
}

export function QueueTriageControls({ item, onTriage, disabled = false }) {
  const operations = Array.isArray(item?.triageOperations)
    ? item.triageOperations.filter((operation) => operation?.available !== false)
    : [];
  if (!onTriage || operations.length === 0) return null;

  const hasOperation = (id) => operations.some((operation) => operation.id === id);
  const snooze = (event) => {
    const duration = Number(event.target.value);
    event.target.value = '';
    if (!Number.isFinite(duration) || duration <= 0) return;
    onTriage(item, 'snooze', { snoozedUntil: new Date(Date.now() + duration).toISOString() });
  };

  return (
    <div className="inline-flex items-center gap-2 flex-wrap">
      {hasOperation('snooze') && (
        <label className="inline-flex items-center">
          <span className="sr-only">Snooze {item.title}</span>
          <select
            defaultValue=""
            aria-label={`Snooze ${item.title}`}
            onChange={snooze}
            disabled={disabled}
            className="min-h-[36px] rounded-md border border-port-warning/30 bg-port-warning/10 px-2 py-1 text-xs font-medium text-port-warning transition-colors hover:bg-port-warning/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent disabled:cursor-not-allowed disabled:opacity-40"
            title="Snooze this action"
          >
            <option value="">Snooze…</option>
            {QUEUE_SNOOZE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      )}
      {hasOperation('unsnooze') && (
        <button
          type="button"
          onClick={() => onTriage(item, 'unsnooze')}
          disabled={disabled}
          className="inline-flex min-h-[36px] items-center gap-1 rounded-md border border-port-warning/30 bg-port-warning/10 px-2 py-1 text-xs font-medium text-port-warning transition-colors hover:bg-port-warning/20 disabled:cursor-not-allowed disabled:opacity-40"
          title="Show this action again"
        >
          <Clock3 size={13} />
          Unsnooze
        </button>
      )}
      {hasOperation('dismiss') && (
        <button
          type="button"
          onClick={() => onTriage(item, 'dismiss')}
          disabled={disabled}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-md border border-port-border px-2 py-1 text-gray-500 transition-colors hover:border-port-warning/40 hover:text-port-warning disabled:cursor-not-allowed disabled:opacity-40"
          title="Dismiss this recommendation"
          aria-label="Dismiss this recommendation"
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}

export function QueueInvestigation({ item }) {
  if (item.investigation) {
    return <QueueInvestigationButton key={item.id} task={item.investigation} className="min-h-[44px] max-w-full" />;
  }
  return item.investigationUnavailable
    ? <p className="w-full text-xs text-port-text-muted">{item.investigationUnavailable}</p>
    : null;
}

export default function ActionQueueRow({
  item,
  onSelect,
  onDrill,
  onResolve,
  onPromoteAsk,
  onTriage,
  onFeedbackSaved,
  onGitHubUpdated,
  onHarnessUpdate,
  harnessUpdatePending,
  harnessWarningDays,
  onHarnessWarningDays,
  actionLink,
  detailOpen = false,
  resolving = false,
}) {
  const borderTone = QUEUE_SEVERITY_STYLE[item.severity] || QUEUE_SEVERITY_STYLE.normal;
  if (item.source === 'github' && item.githubNotification) {
    return (
      <div className={`min-w-0 rounded-lg border bg-port-card ${borderTone}`}>
        <p className="px-3 pt-2 text-xs font-medium text-port-warning">{item.sourceLabel}</p>
        {detailOpen ? (
          <button type="button" onClick={() => onSelect?.(item)} className="min-h-[44px] px-3 py-2 text-left text-sm text-white break-words">{item.title}</button>
        ) : (
          <GitHubNotificationCard
            notification={item.githubNotification}
            accountLabel={item.githubNotification.accountLabel}
            detailTo={actionLink}
            onUpdated={(_row, updated) => onGitHubUpdated(item, updated)}
          />
        )}
        {!detailOpen && item.triageOperations?.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-port-border px-3 py-2">
            <QueueTriageControls item={item} onTriage={onTriage} disabled={resolving} />
          </div>
        )}
      </div>
    );
  }

  const config = QUEUE_SOURCE_CONFIG[item.source] || { icon: Inbox, color: 'text-gray-400' };
  const Icon = config.icon;
  const pullRequestUrl = safeExternalHttpUrl(item.meta?.reviewLoopPRUrl);
  const promoteTargets = Array.isArray(item.promoteTargets) ? item.promoteTargets : [];
  const goalOptions = Array.isArray(item.goalOptions) ? item.goalOptions : [];
  // The goal target needs a goalId, so it's rendered as a picker rather than a
  // one-click button — split it out from the simple brain/task targets.
  const simpleTargets = promoteTargets.filter(t => t !== 'goal');
  const showGoalPicker = promoteTargets.includes('goal') && goalOptions.length > 0;
  const sourceOperations = !promoteTargets.length && Array.isArray(item.operations)
    ? item.operations.filter(isInlineResolution)
    : [];
  const rateOperation = sourceOperations.find((operation) => operation.id === 'rate' && operation.input?.type === 'rating');
  // Agent-run feedback renders the shared agent card right in the queue so the
  // rating can be submitted without opening the detail drawer. While that drawer
  // is open it hosts the card, so the row defers to it (one live card at a time).
  const feedbackRun = item.source === 'feedback' && item.available !== false && item.availability !== 'unavailable';
  const inlineFeedback = feedbackRun && !detailOpen;
  const inlineActions = item.action
    ? [{ id: 'resolve', label: item.action }]
    : sourceOperations.filter((operation) => operation.id !== 'rate');

  return (
    <div className={`grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 p-3 rounded-lg border bg-port-card ${borderTone}`}>
      <div className={`mt-0.5 shrink-0 ${config.color}`}>
        <Icon size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => onSelect?.(item)}
            className="min-w-0 break-words text-sm font-medium text-white text-left hover:text-port-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent rounded"
            aria-label={`Open action ${item.title}`}
          >
            {item.title}
          </button>
          <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border border-current/20 ${config.color}`}>
            {item.sourceLabel}
          </span>
        </div>
        {item.summary && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2 break-words">{item.summary}</p>
        )}
        <QueueMetaChips meta={item.meta} />
        {pullRequestUrl && (
          <a
            href={pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex min-h-[32px] items-center gap-1 text-xs text-port-accent hover:underline"
          >
            <ExternalLink size={12} /> Open pull request
          </a>
        )}
        {item.timestamp && (
          <p className="text-xs text-gray-600 mt-1 flex items-center gap-1">
            <Clock3 size={12} />
            {timeAgo(item.timestamp)}
          </p>
        )}
      </div>
      {inlineFeedback && (
        <div className="col-span-2 min-w-0 border-t border-port-border/50 pt-2">
          <AgentFeedbackReview key={item.sourceRef} item={item} onSaved={onFeedbackSaved} />
        </div>
      )}
      <div className="col-span-2 flex min-w-0 items-center gap-2 flex-wrap border-t border-port-border/50 pt-2 sm:col-start-2 sm:col-span-1 [&_button]:min-h-[44px] [&_select]:min-h-[44px]">
        {item.source === 'updates' && item.harnessUpdate?.updatable && !item.unverified && onHarnessUpdate && <HarnessUpdateControl
          harness={item.harnessUpdate} warningDays={harnessWarningDays} onWarningDays={onHarnessWarningDays} onUpdate={onHarnessUpdate} disabled={resolving || harnessUpdatePending} />}
        <QueueInvestigation item={item} />
        {onResolve && rateOperation && !feedbackRun && (
          <button type="button" onClick={() => onSelect?.(item)} className="inline-flex items-center gap-2 rounded border border-port-accent/30 px-3 py-2 text-sm text-port-accent">
            <Eye size={14} /> Review run and give feedback
          </button>
        )}
        {onResolve && inlineActions.map(action => (
          <button
            key={action.id}
            onClick={() => onResolve(item, action.id === 'resolve' ? undefined : action.id)}
            disabled={resolving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-port-success bg-port-success/10 hover:bg-port-success/20 border border-port-success/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={`${action.label} this item in place`}
          >
            <Check size={14} />
            {action.label}
          </button>
        ))}
        {onPromoteAsk && simpleTargets.map(target => (
          <button
            key={target}
            onClick={() => onPromoteAsk(item, target)}
            disabled={resolving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium text-port-accent bg-port-accent/10 hover:bg-port-accent/20 border border-port-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={`Promote the latest answer to ${PROMOTE_TARGET_LABEL[target] || target}`}
          >
            <ArrowRight size={12} />
            {PROMOTE_TARGET_LABEL[target] || target}
          </button>
        ))}
        {showGoalPicker && onPromoteAsk && (
          <label className="inline-flex items-center gap-1 text-xs">
            <span className="sr-only">Promote the latest answer to a goal</span>
            <select
              defaultValue=""
              disabled={resolving}
              onChange={(e) => {
                const goalId = e.target.value;
                if (!goalId) return;
                onPromoteAsk(item, 'goal', goalId);
                e.target.value = '';
              }}
              className="px-2 py-1 rounded-md text-xs font-medium text-port-accent bg-port-accent/10 hover:bg-port-accent/20 border border-port-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-port-accent"
              title="Promote the latest answer into a goal's progress"
            >
              <option value="">→ Goal…</option>
              {goalOptions.map(g => (
                <option key={g.id} value={g.id}>{g.title}</option>
              ))}
            </select>
          </label>
        )}
        <QueueTriageControls item={item} onTriage={onTriage} disabled={resolving} />
        {item.drillTo && (
          <button
            type="button"
            onClick={() => onDrill(item)}
            className="min-h-[44px] inline-flex items-center gap-1 rounded-md border border-port-accent/30 px-2 py-1 text-xs font-medium text-port-accent hover:bg-port-accent/10 transition-colors"
          >
            <ArrowRight size={16} /> {item.drillLabel || 'Open source'}
          </button>
        )}
      </div>
    </div>
  );
}
