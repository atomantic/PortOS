import { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { Link } from 'react-router';
import {
  AlertTriangle, CheckCircle2, ExternalLink, GitBranch, GitMerge,
  GitPullRequest, Loader2, RefreshCw, Rocket, ScanSearch, Search, ShieldAlert, User
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import Banner from '../../ui/Banner';
import Pill from '../../ui/Pill';
import toast from '../../ui/Toast';
import { useCosTaskUpdates } from '../../../hooks/useCosTaskUpdates';
import * as api from '../../../services/api';
import { timeAgo } from '../../../utils/formatters';

const FORGE_LABEL = { github: 'GitHub', gitlab: 'GitLab' };

const ACTION_STATUS_RANK = { queuing: 0, queued: 1, active: 2, completed: 3, blocked: 3 };
const ACTION_STATUS_LABEL = {
  queued: 'Queued — view',
  active: 'Active — view',
  completed: 'Completed — view',
  blocked: 'Blocked — view',
};

const actionStatusForTask = status => ({
  pending: 'queued',
  in_progress: 'active',
  completed: 'completed',
  blocked: 'blocked',
}[status] || null);

// The two per-row agent actions. They share every piece of state machinery —
// only the CoS task that backs each one differs, so the kind is data rather
// than a duplicated block of hooks.
//   resolve — the review-loop follow-up that fixes and merges the branch.
//   review  — `pr-reviewer` narrowed to this one request.
// `field` is where the GET response carries this kind's server-side state, and
// `queued` reads the same record out of the POST response. `matches` is the
// LATE-BINDING rule: a click knows its PR number before the server has a task
// id, so a socket update is claimed by the row it names.
const ACTION_KINDS = {
  resolve: {
    label: 'Resolve & merge',
    Icon: Rocket,
    field: 'agentAction',
    queued: result => result.task && { taskId: result.task.id, status: result.task.status },
    title: (forgeLabel, number, appName) =>
      `Queue a CoS agent to resolve and merge ${forgeLabel} request #${number} for ${appName}`,
    matches: (task, appId, number) => task.metadata?.app === appId
      && Number(task.metadata?.reviewLoopPRNumber) === number,
  },
  review: {
    label: 'PR review',
    Icon: ScanSearch,
    field: 'reviewAction',
    queued: result => result.reviewAction,
    title: (forgeLabel, number, appName) =>
      `Run the pr-reviewer scheduled task against ${forgeLabel} request #${number} for ${appName}`,
    matches: (task, appId, number) => task.metadata?.app === appId
      && task.metadata?.analysisType === 'pr-reviewer'
      && Number(task.metadata?.targetPullRequest) === number,
  },
};
const KIND_IDS = Object.keys(ACTION_KINDS);
const emptyActions = () => Object.fromEntries(KIND_IDS.map(kind => [kind, {}]));

const EMPTY_REASONS = {
  'no-repo-path': 'This app has no repo path configured.',
  'unsupported-forge': 'This app\'s git origin is not a GitHub or GitLab repository, so there are no PRs/MRs to list.',
  'no-open-pull-requests': 'No open pull requests or merge requests.',
};

const PASSING_CHECKS = new Set(['SUCCESS', 'PASSED', 'NEUTRAL', 'SKIPPED', 'COMPLETED']);
const FAILING_CHECKS = new Set(['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMED_OUT', 'ACTION_REQUIRED']);

function checkSummary(pullRequest) {
  const checks = Array.isArray(pullRequest.checks) ? pullRequest.checks : [];
  if (checks.some(check => FAILING_CHECKS.has(String(check.status || '').toUpperCase()))) {
    return { label: 'Checks failing', tone: 'error', icon: ShieldAlert };
  }
  if (!checks.length || checks.some(check => !PASSING_CHECKS.has(String(check.status || '').toUpperCase()))) {
    return { label: checks.length ? 'Checks pending' : 'Checks pending · none reported', tone: 'warning', icon: RefreshCw };
  }
  return { label: 'Checks passing', tone: 'success', icon: CheckCircle2 };
}

function reviewSummary(pullRequest) {
  switch (String(pullRequest.reviewDecision || '').toUpperCase()) {
    case 'APPROVED':
      return { label: 'Approved', tone: 'success' };
    case 'CHANGES_REQUESTED':
      return { label: 'Changes requested', tone: 'error' };
    case 'REVIEW_REQUIRED':
      return { label: 'Review required', tone: 'warning' };
    default:
      return { label: 'Review pending', tone: 'muted' };
  }
}

function mergeSummary(pullRequest) {
  const status = String(pullRequest.mergeStateStatus || pullRequest.mergeable || '').toUpperCase();
  if (['CLEAN', 'MERGEABLE', 'CAN_BE_MERGED'].includes(status)) {
    return { label: 'Mergeable', tone: 'success' };
  }
  if (['DIRTY', 'CONFLICTING', 'CANNOT_BE_MERGED'].includes(status)) {
    return { label: 'Conflicts', tone: 'error' };
  }
  if (['BLOCKED', 'CANNOT_BE_MERGED_RESTRICTED'].includes(status)) {
    return { label: 'Merge blocked', tone: 'warning' };
  }
  if (status === 'BEHIND') return { label: 'Behind base', tone: 'warning' };
  return { label: 'Mergeability pending', tone: 'muted' };
}

function actionStatusFromRecord(record) {
  return record ? actionStatusForTask(record.status) : null;
}

function actionRank(status) {
  return ACTION_STATUS_RANK[status] ?? -1;
}

/**
 * Open PRs/MRs for a managed app. Each row includes the forge's review/check
 * state and can queue the same PortOS review-loop agent used by PR cleanup.
 */
export default function PullRequestsTab({ appId, appName }) {
  const searchId = useId();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [actions, setActions] = useState(emptyActions);
  const actionsRef = useRef(emptyActions());
  const requestRef = useRef(0);

  // One writer for the whole `{ kind: { number: action } }` bag so the ref the
  // socket handler reads and the state React renders can never disagree.
  const replaceActions = useCallback(updater => {
    const next = updater(actionsRef.current);
    actionsRef.current = next;
    setActions(next);
  }, []);

  const setAction = useCallback((kind, number, action) => {
    replaceActions(previous => ({
      ...previous,
      [kind]: action
        ? { ...previous[kind], [number]: action }
        : Object.fromEntries(Object.entries(previous[kind]).filter(([key]) => Number(key) !== number)),
    }));
  }, [replaceActions]);

  useEffect(() => {
    actionsRef.current = emptyActions();
    setActions(emptyActions());
  }, [appId]);

  const applyTaskUpdate = useCallback(task => {
    if (!task?.id) return;
    const nextStatus = actionStatusForTask(task.status);
    if (!nextStatus) return;

    replaceActions(current => {
      let changed = false;
      const next = { ...current };
      for (const kind of KIND_IDS) {
        const updated = { ...current[kind] };
        for (const [number, action] of Object.entries(current[kind])) {
          const matches = action.taskId === task.id
            || (!action.taskId && ACTION_KINDS[kind].matches(task, appId, Number(number)));
          if (!matches || actionRank(nextStatus) < actionRank(action.status)) continue;
          updated[number] = { ...action, taskId: action.taskId || task.id, status: nextStatus };
          changed = true;
        }
        next[kind] = updated;
      }
      return changed ? next : current;
    });
  }, [appId, replaceActions]);

  useCosTaskUpdates(applyTaskUpdate);

  const load = useCallback(async () => {
    const generation = requestRef.current + 1;
    requestRef.current = generation;
    const isCurrent = () => requestRef.current === generation;

    setLoading(true);
    setError('');
    const result = await api.getAppPullRequests(appId).catch(err => {
      if (isCurrent()) setError(err?.message || 'Failed to load pull requests');
      return null;
    });
    if (!isCurrent()) return;
    setLoading(false);
    if (!result) return;

    setData(result);
    replaceActions(previous => {
      const next = { ...previous };
      for (const kind of KIND_IDS) {
        const merged = { ...previous[kind] };
        for (const pullRequest of result.pullRequests || []) {
          const record = pullRequest[ACTION_KINDS[kind].field];
          const serverAction = actionStatusFromRecord(record);
          if (!serverAction) continue;
          const current = merged[pullRequest.number];
          if (!current || actionRank(serverAction) >= actionRank(current.status)) {
            merged[pullRequest.number] = {
              ...(current || {}),
              taskId: current?.taskId || record.taskId || null,
              status: serverAction,
            };
          }
        }
        next[kind] = merged;
      }
      return next;
    });
  }, [appId, replaceActions]);

  useEffect(() => { load(); }, [load]);

  const filteredPullRequests = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return data?.pullRequests || [];
    return (data?.pullRequests || []).filter(pullRequest => [
      pullRequest.number,
      pullRequest.title,
      pullRequest.author,
      pullRequest.headBranch,
      pullRequest.baseBranch,
      ...(pullRequest.labels || []),
    ].some(value => String(value || '').toLowerCase().includes(q)));
  }, [data, query]);

  const total = data?.pullRequests?.length ?? 0;
  const forgeLabel = FORGE_LABEL[data?.forge] || 'Forge';
  const requestNoun = data?.forge === 'gitlab' ? 'merge requests' : 'pull requests';
  const unavailable = data?.transient === true;

  // Both row actions queue a CoS task and then track it identically: optimistic
  // `queuing`, roll back on failure, and never let a stale response downgrade a
  // status a socket update already advanced.
  const queueAction = async (kind, pullRequest, { call, queued, already }) => {
    const { number } = pullRequest;
    setAction(kind, number, { status: 'queuing', taskId: null });
    const result = await call().catch(err => {
      toast.error(err?.message || `Failed to queue an agent for #${number}`);
      return null;
    });
    if (!result) {
      setAction(kind, number, null);
      return;
    }

    const record = ACTION_KINDS[kind].queued(result);
    const taskStatus = actionStatusFromRecord(record) || 'queued';
    replaceActions(previous => {
      const current = previous[kind][number];
      const status = actionRank(taskStatus) >= actionRank(current?.status) ? taskStatus : current?.status;
      return {
        ...previous,
        [kind]: {
          ...previous[kind],
          [number]: {
            ...(current || {}),
            taskId: current?.taskId || record?.taskId || null,
            status,
          },
        },
      };
    });
    toast.success(result.duplicate ? already : queued);
  };

  const handleResolve = pullRequest => queueAction('resolve', pullRequest, {
    call: () => api.resolveAppPullRequest(appId, pullRequest.number),
    queued: `Queued an agent to resolve and merge ${forgeLabel} #${pullRequest.number}`,
    already: `An agent is already resolving ${forgeLabel} #${pullRequest.number}`,
  });

  const handleReview = pullRequest => queueAction('review', pullRequest, {
    call: () => api.reviewAppPullRequest(appId, pullRequest.number),
    queued: `Queued the pr-reviewer task for ${forgeLabel} #${pullRequest.number}`,
    already: `pr-reviewer is already queued for ${forgeLabel} #${pullRequest.number}`,
  });

  // pr-reviewer covers only GitHub PRs opened by someone else against the default
  // branch, and the server answers every other row with 409. `reviewEligible` is
  // the server's own verdict per row, so the button appears exactly where it can
  // work rather than offering a guaranteed failure.
  const rowActionsFor = pullRequest => [
    { kind: 'resolve', onQueue: handleResolve },
    ...(pullRequest.reviewEligible ? [{ kind: 'review', onQueue: handleReview }] : []),
  ];

  if (loading && !data) return <BrailleSpinner text="Loading pull requests" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-semibold text-white">
          {forgeLabel} PRs / MRs
          {data?.fullName && <span className="ml-2 text-xs font-mono text-gray-500">{data.fullName}</span>}
        </h3>
        {total > 0 && (
          <span className="text-xs text-gray-500">
            {filteredPullRequests.length === total ? `${total} open` : `${filteredPullRequests.length} of ${total} open`}
          </span>
        )}
        <div className="relative ml-auto">
          <label htmlFor={searchId} className="sr-only">Filter pull requests</label>
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Filter by title, branch, author…"
            className="w-full sm:w-72 pl-8 pr-3 py-1.5 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden"
          />
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="px-3 py-2 text-xs text-gray-500 bg-port-card border border-port-border rounded-lg space-y-1">
        <p>
          Resolve and merge queues a PortOS agent to inspect feedback, fix the branch, wait for checks, and merge when the forge allows it. It uses the configured Code Review Defaults.
        </p>
        {(data?.pullRequests || []).some(pullRequest => pullRequest.reviewEligible) && (
          <p>
            PR review points the <span className="font-mono">pr-reviewer</span> scheduled task at this one request instead of letting it sweep every open contributor PR. It appears only on requests it can review — opened by someone else against the default branch — and its security scan still holds the review behind approval.
          </p>
        )}
      </div>

      {error && (
        <Banner tone="error" size="md" icon={AlertTriangle}>
          Couldn&apos;t load pull requests — {error}
        </Banner>
      )}

      {!error && unavailable && (
        <Banner tone="warning" size="md" icon={AlertTriangle}>
          {data.headline || `Couldn't reach ${forgeLabel}`} ({data.reason})
          {data.remedy ? ` — ${data.remedy}.` : ''}
        </Banner>
      )}

      {!error && !unavailable && total === 0 && (
        <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg">
          {EMPTY_REASONS[data?.reason] ?? EMPTY_REASONS['no-open-pull-requests']}
        </div>
      )}

      {filteredPullRequests.length === 0 && total > 0 && (
        <div className="px-3 py-2 text-sm text-gray-500 bg-port-card border border-port-border rounded-lg">
          No open {requestNoun} match &ldquo;{query}&rdquo;.
        </div>
      )}

      {filteredPullRequests.length > 0 && (
        <div className="border border-port-border rounded-lg divide-y divide-port-border overflow-hidden">
          {filteredPullRequests.map(pullRequest => {
            const review = reviewSummary(pullRequest);
            const checks = checkSummary(pullRequest);
            const merge = mergeSummary(pullRequest);
            const openStatus = pullRequest.isDraft
              ? { label: 'Draft', tone: 'warning' }
              : { label: 'Open', tone: 'success' };

            return (
              <div key={pullRequest.number} className="bg-port-card p-3">
                <div className="flex flex-col lg:flex-row lg:items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <GitPullRequest size={15} className="text-port-accent shrink-0 self-center" />
                      <span className="text-xs font-mono text-gray-500">#{pullRequest.number}</span>
                      {pullRequest.url ? (
                        <a
                          href={pullRequest.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-sm text-white hover:text-port-accent transition-colors break-words"
                        >
                          {pullRequest.title || '(untitled)'}
                        </a>
                      ) : (
                        <span className="text-sm text-white break-words">{pullRequest.title || '(untitled)'}</span>
                      )}
                      {pullRequest.url && (
                        <a
                          href={pullRequest.url}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Open ${forgeLabel} request ${pullRequest.number}`}
                          className="text-gray-500 hover:text-port-accent transition-colors self-center"
                        >
                          <ExternalLink size={12} />
                        </a>
                      )}
                      <Pill tone={openStatus.tone} size="xs">{openStatus.label}</Pill>
                    </div>

                    <div className="flex flex-wrap gap-1.5 mt-2">
                      <Pill tone={review.tone} size="xs">{review.label}</Pill>
                      <Pill tone={checks.tone} size="xs" icon={checks.icon}>{checks.label}</Pill>
                      <Pill tone={merge.tone} size="xs" icon={merge.tone === 'success' ? GitMerge : undefined}>{merge.label}</Pill>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-gray-500">
                      {pullRequest.author && <span className="flex items-center gap-1"><User size={12} /> {pullRequest.author}</span>}
                      {(pullRequest.headBranch || pullRequest.baseBranch) && (
                        <span className="flex items-center gap-1 font-mono">
                          <GitBranch size={12} /> {pullRequest.headBranch || '?'} → {pullRequest.baseBranch || '?'}
                        </span>
                      )}
                      {pullRequest.updatedAt && <span>updated {timeAgo(pullRequest.updatedAt)}</span>}
                    </div>
                  </div>

                  <div className="shrink-0 lg:pt-0.5 flex flex-wrap items-start gap-2">
                    {rowActionsFor(pullRequest).map(({ kind, onQueue }) => {
                      const { label, Icon, title } = ACTION_KINDS[kind];
                      const actionStatus = actions[kind][pullRequest.number]?.status;
                      if (actionStatus && actionStatus !== 'queuing') {
                        return (
                          <Link
                            key={kind}
                            to="/cos/agents"
                            className="px-3 py-1.5 bg-port-success/20 text-port-success hover:bg-port-success/30 border border-port-border rounded-lg text-xs flex items-center gap-1.5 transition-colors"
                          >
                            <Icon size={14} /> {label}: {ACTION_STATUS_LABEL[actionStatus] || 'Queued — view'}
                          </Link>
                        );
                      }
                      return (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => onQueue(pullRequest)}
                          disabled={actionStatus === 'queuing'}
                          title={title(forgeLabel, pullRequest.number, appName)}
                          className="px-3 py-1.5 bg-port-accent/20 text-port-accent enabled:hover:bg-port-accent/30 border border-port-border rounded-lg text-xs flex items-center gap-1.5 disabled:opacity-50 transition-colors"
                        >
                          {actionStatus === 'queuing'
                            ? <Loader2 size={14} className="animate-spin" />
                            : <Icon size={14} />}
                          {actionStatus === 'queuing' ? 'Queuing…' : label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
