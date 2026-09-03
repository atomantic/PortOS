/**
 * "Queue agent to investigate" action for an installer failure (#5981).
 *
 * An install error used to be a dead end — Close was the only affordance — even
 * though PortOS already owns an autonomous-agent queue. This button hands the
 * failure straight to that queue: it builds a reproducible task from the
 * installer name, the failing stage, the error and the streamed log tail, and
 * posts it via `addCosTask` with no `app`, which targets PortOS itself (the
 * installer code lives in this repo).
 *
 * Rendered by `InstallErrorFooter` (both install modals) and directly by
 * `LocalSetupPanel`, which draws its own error region.
 */

import { useState } from 'react';
import { Bot, Check } from 'lucide-react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { buildInstallFailureTask } from '../../lib/installFailureTask';
import { addCosTask } from '../../services/api';
import toast from '../ui/Toast';

// Unattended repair work, same posture as `INVESTIGATION_TASK_DELIVERY`
// (`server/lib/investigationTasks.js`): keep it out of the user's checkout and
// send it through the PR gate. It deliberately stops short of that constant's
// `prCompletion: merge-on-green`, and carries no `isInvestigation` marker —
// `createCosTaskSchema` has no such field, so a client-queued task sits outside
// the investigation dedup/circuit-breaker machinery. Tracked in #6043.
const INSTALL_INVESTIGATION_DELIVERY = { useWorktree: true, openPR: true };

export default function QueueInstallInvestigationButton({
  label,
  stage,
  error,
  logs,
  surface,
  className = '',
}) {
  // null = not queued yet · 'queued' = this click created the task ·
  // 'duplicate' = the store already held one. They read differently to the user:
  // the store's 409 also fires for a task it has BLOCKED, which will not run
  // without intervention, so this must not claim an agent is on it.
  const [queueResult, setQueueResult] = useState(null);
  // `useAsyncAction` owns the failure toast, so the request itself is silent —
  // otherwise the user gets two toasts for one failed queue.
  const [queueTask, queueing] = useAsyncAction(async () => {
    const task = buildInstallFailureTask({ label, stage, error, logs, surface });
    // The description is deterministic per installer + stage, so retrying the
    // same failing install and clicking again hits the store's duplicate guard
    // (409 DUPLICATE_TASK). A task already exists — not a failure to report.
    const duplicateMessage = await addCosTask({ ...task, ...INSTALL_INVESTIGATION_DELIVERY }, { silent: true })
      .then(() => null)
      .catch((err) => {
        // The server names the existing task's status ("already pending" /
        // "already blocked"); pass it through rather than guessing.
        if (err?.code === 'DUPLICATE_TASK') return err.message || 'A task for this failure already exists';
        throw err;
      });
    setQueueResult(duplicateMessage ? 'duplicate' : 'queued');
    if (duplicateMessage) toast(duplicateMessage, { icon: '🤖' });
    else toast.success('Queued an agent to investigate this failure');
  }, { errorMessage: 'Failed to queue the investigation task' });

  return (
    <button
      type="button"
      onClick={queueTask}
      disabled={queueing || queueResult !== null}
      title={queueResult === 'queued'
        ? 'Queued — track it in Agent Ops'
        : queueResult === 'duplicate'
          ? 'A CoS task for this failure already exists — see Agent Ops'
          : 'Queue a PortOS agent task to investigate this install failure'}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 disabled:hover:bg-port-accent ${className}`}
    >
      {queueResult ? <Check size={14} /> : <Bot size={14} />}
      {queueResult === 'queued'
        ? 'Agent queued'
        : queueResult === 'duplicate'
          ? 'Task already exists'
          : queueing ? 'Queueing…' : 'Queue agent to investigate'}
    </button>
  );
}
