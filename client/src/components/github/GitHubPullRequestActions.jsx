import { useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { MergeAction, PullRequestReviewButton, DEFAULT_MERGE_METHOD, ACTION_STATUS_LABEL, actionStatusForTask } from '../apps/tabs/PullRequestActionControls';
import GitHubAgentPinForm from './GitHubAgentPinForm';
import { actOnGitHubNotificationPullRequest } from '../../services/api';
import toast from '../ui/Toast';
import { useCosTaskUpdates } from '../../hooks/useCosTaskUpdates';

export default function GitHubPullRequestActions({ notification, onUpdated }) {
  const id = useId();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(null);
  const [armed, setArmed] = useState(false);
  const [method, setMethod] = useState(DEFAULT_MERGE_METHOD);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [reviewAction, setReviewAction] = useState(null);
  const [error, setError] = useState('');
  const pr = notification.pullRequest;
  const run = notification.pullRequestAction;
  const [progress, setProgress] = useState(null);
  const current = progress && progress.at === run?.at ? progress : run;
  useCosTaskUpdates(task => {
    if (!run || run.merged) return;
    const matches = current?.taskId === task.id || (!current?.taskId && run.appId
      && task.metadata?.app === run.appId && Number(task.metadata?.targetPullRequest) === pr.number
      && task.metadata?.analysisType === 'pr-reviewer');
    if (!matches) return;
    setProgress({ ...run, taskId: task.metadata?.preflightResultTaskId || task.id,
      status: task.metadata?.preflightFailure ? 'failed' : task.metadata?.preflightResultTaskId ? 'active' : actionStatusForTask(task.status) });
  });

  const execute = async (action, pin = {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setError('');
    const result = await actOnGitHubNotificationPullRequest(notification.accountId, notification.threadId, {
      action, ...(action === 'merge' ? { method, deleteBranch } : pin),
    }, { silent: true }).catch(err => { setError(err.message || 'The PR action failed'); return null; });
    inFlight.current = false;
    setBusy(null);
    if (!result) return;
    setArmed(false);
    setReviewAction(null);
    onUpdated(notification, result.notification);
    toast.success(result.merged ? `Merged PR #${pr.number}` : result.duplicate ? 'A review is already queued' : result.started ? 'Review started' : 'Review queued');
  };

  return (
    <div className="flex max-w-full min-w-0 flex-wrap items-center gap-1.5">
      {current && !current.merged && (
        current.taskId ? <Link className="text-xs text-port-accent hover:underline" to={`/cos/tasks?task=${encodeURIComponent(current.taskId)}&source=internal`}>Review: {ACTION_STATUS_LABEL[current.status] || 'View task'}</Link>
          : current.appId ? <Link className="text-xs text-port-accent hover:underline" to={`/apps/${encodeURIComponent(current.appId)}/pull-requests`}>Review requested — view PRs</Link> : null
      )}
        {['do-review', 'untrusted-review'].filter(action => pr[action === 'do-review' ? 'doReviewEligible' : 'reviewEligible']).map(action => (
          <PullRequestReviewButton key={action} action={action} disabled={Boolean(busy)} busy={busy === action}
            onClick={() => { setReviewAction(action); setArmed(false); }} />
        ))}
        {pr.mergeEligible && <MergeAction pullRequest={pr} idPrefix={id} armed={armed} merging={busy === 'merge'}
          method={method} onMethodChange={setMethod} deleteBranch={deleteBranch} onDeleteBranchChange={setDeleteBranch}
          onArm={() => { setArmed(true); setReviewAction(null); }} onCancel={() => setArmed(false)} onConfirm={() => execute('merge')}
          disabled={Boolean(busy)} title="Merge this PR after checking its current head, reviews and CI" />}
      {reviewAction && <GitHubAgentPinForm pin={notification.agent?.pin} label="PR review provider" submitLabel="Start review"
        busy={Boolean(busy)} onSubmit={pin => execute(reviewAction, pin)} onCancel={() => setReviewAction(null)} />}
      {error && <p role="alert" className="w-full break-words text-xs text-port-error">{error}</p>}
      {!error && notification.pullRequestAttempt?.reason === 'GITHUB_PR_NOT_READY' && <p className="w-full text-xs text-gray-400">Auto-merge is waiting for passing checks and merge readiness.</p>}
    </div>
  );
}
