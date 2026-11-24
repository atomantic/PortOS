import { useState } from 'react';
import { Link } from 'react-router';
import { ListPlus } from 'lucide-react';
import { claimGitHubNotificationIssue } from '../../services/apiGithub.js';
import GitHubAgentPinForm from './GitHubAgentPinForm';

/** The issue-management claim, not the generic notification resolution action. */
export default function GitHubIssueClaim({ notification, busy, runMutation }) {
  const [picking, setPicking] = useState(false);
  const [claim, setClaim] = useState(null);
  const submit = pin => runMutation(async () => {
    const result = await claimGitHubNotificationIssue(notification.accountId, notification.threadId, pin).catch(() => null);
    if (result?.taskId) {
      setClaim(result);
      setPicking(false);
    }
  });

  if (claim) return (
    <Link to={`/cos/tasks?task=${encodeURIComponent(claim.taskId)}&source=user`} className="rounded px-2.5 py-1 text-xs text-port-accent hover:underline">
      {claim.duplicate ? 'Claim already queued' : 'Claim queued'}
    </Link>
  );

  if (picking) return (
    <div className="w-full">
      <GitHubAgentPinForm label={`Claim GitHub issue #${notification.claimIssue}`} submitLabel="Queue claim" busy={busy}
        onSubmit={submit} onCancel={() => setPicking(false)} />
    </div>
  );

  return (
    <button type="button" disabled={busy} onClick={() => setPicking(true)}
      className="inline-flex min-h-[36px] items-center gap-1 rounded-lg border border-port-border px-3 py-1.5 text-xs font-medium text-gray-200 hover:border-gray-500 disabled:opacity-50"
    >
      <ListPlus size={13} aria-hidden="true" /> Claim issue
    </button>
  );
}
