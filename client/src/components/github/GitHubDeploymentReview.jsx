import { useEffect, useId, useState } from 'react';
import { getGitHubDeploymentReview, reviewGitHubDeployment } from '../../services/api';

// Approve or reject the environments a waiting workflow run is blocked on.
// Operator only: the server re-checks every id against the run's pending list.
export default function GitHubDeploymentReview({ notification, onReviewed, onCancel }) {
  const formId = useId();
  const [environments, setEnvironments] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(null);

  useEffect(() => {
    let live = true;
    getGitHubDeploymentReview(notification.accountId, notification.threadId)
      .then((review) => {
        if (!live) return;
        setEnvironments(review.environments);
        setSelected(new Set(review.environments.filter((entry) => entry.canApprove).map((entry) => entry.environmentId)));
      })
      .catch(() => live && setLoadFailed(true));
    return () => { live = false; };
  }, [notification.accountId, notification.threadId]);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  const submit = async (state) => {
    setSubmitting(state);
    const updated = await reviewGitHubDeployment(notification.accountId, notification.threadId, {
      state, environmentIds: [...selected], ...(comment.trim() ? { comment: comment.trim() } : {}),
    }).catch(() => null);
    setSubmitting(null);
    if (updated) onReviewed(updated);
  };

  const panel = 'mt-2 space-y-2 rounded-lg border border-port-border bg-port-bg p-3 text-xs';
  if (loadFailed) return <p role="alert" className={`${panel} text-port-error`}>Could not read the deployment from GitHub.</p>;
  if (!environments) return <p className={`${panel} text-gray-400`}>Loading the deployment…</p>;
  if (!environments.length) {
    return <p className={`${panel} text-gray-400`}>Nothing is waiting on this run any more. It was approved, rejected or expired; the next check marks it finished.</p>;
  }
  const busy = submitting !== null;
  return (
    <form className={panel} aria-label="Review deployment" onSubmit={(event) => event.preventDefault()}>
      <fieldset className="space-y-1.5">
        <legend className="mb-1 text-gray-400">Environments waiting on you</legend>
        {environments.map((entry) => {
          const id = `${formId}-env-${entry.environmentId}`;
          return (
            <div key={entry.environmentId} className="flex min-w-0 items-start gap-2">
              <input
                id={id}
                type="checkbox"
                checked={selected.has(entry.environmentId)}
                disabled={!entry.canApprove || busy}
                onChange={() => toggle(entry.environmentId)}
                className="mt-0.5"
              />
              <label htmlFor={id} className="min-w-0 break-words text-gray-200">
                <span className="font-mono text-white">{entry.name}</span>
                {!entry.canApprove && <span className="text-gray-500"> · only {entry.reviewers.join(', ') || 'its reviewers'} can approve</span>}
              </label>
            </div>
          );
        })}
      </fieldset>
      <label htmlFor={`${formId}-comment`} className="block space-y-1 text-gray-400">
        <span className="block">Comment (optional)</span>
        <textarea
          id={`${formId}-comment`}
          value={comment}
          maxLength={1000}
          rows={2}
          onChange={(event) => setComment(event.target.value)}
          className="w-full rounded border border-port-border bg-port-card px-2 py-1.5 text-sm text-white"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => submit('approved')}
          disabled={busy || selected.size === 0}
          className="min-h-[36px] rounded-lg bg-port-success px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {submitting === 'approved' ? 'Approving…' : 'Approve and deploy'}
        </button>
        <button
          type="button"
          onClick={() => submit('rejected')}
          disabled={busy || selected.size === 0}
          className="min-h-[36px] rounded-lg border border-port-error/60 px-3 py-1.5 text-xs text-port-error disabled:opacity-50"
        >
          {submitting === 'rejected' ? 'Rejecting…' : 'Reject'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="min-h-[36px] rounded-lg px-3 py-1.5 text-xs text-gray-400 disabled:opacity-50">
          Cancel
        </button>
      </div>
    </form>
  );
}
