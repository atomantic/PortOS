/** Bridge CoS tasks into the Brain bullet journal without creating noise. */

import { TIMED_COOLDOWN_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import * as brainStorage from './brainStorage.js';

const TASK_REF_KIND = 'cos.task';

export async function ensureTaskThread({ taskId, title, nextAction, notes, priority = 'normal' }) {
  if (!taskId || !title) return null;
  const threads = await brainStorage.getThreads();
  const existing = threads.find(thread => thread.status !== 'archived'
    && thread.refs?.some(ref => ref?.kind === TASK_REF_KIND && ref?.id === taskId));
  if (existing) return existing;
  return brainStorage.createThread({
    title,
    status: 'open',
    priority,
    nextAction: nextAction || 'Review the task in CoS',
    notes: notes || '',
    refs: [{ kind: TASK_REF_KIND, id: taskId, label: title }],
    source: 'cos',
  });
}

// Exact legacy producer signatures, not a title-prefix filter. Only pristine
// records with the original single task reference qualify for reconciliation.
function legacyCleanupThread(thread, task) {
  if (!task || thread.source !== 'cos' || thread.status !== 'open' || thread.priority !== 'high'
    || !thread.createdAt || thread.updatedAt !== thread.createdAt || thread.refs?.length !== 1
    || thread.refs[0].kind !== TASK_REF_KIND || thread.refs[0].id !== task.id
    || thread.refs[0].label !== thread.title || thread.dueAt || thread.waitingOn
    || thread.pinned || thread.tags?.length) return false;
  // Unknown and actionable holds remain visible. A spent cognitive budget is
  // not permission to conceal a real decision, credential or authorization gap.
  if (task.approvalRequired || task.metadata?.blocker
    || (!['pending', 'in_progress', 'completed', 'cancelled'].includes(task.status)
      && !(task.status === 'blocked' && TIMED_COOLDOWN_BLOCKED_CATEGORIES.has(task.metadata?.blockedCategory)))
    || task.metadata?.taskOutcome?.recovery?.mode === 'approval') return false;
  const origin = task.metadata?.recoveryOrigin;
  const repoMatch = task.description?.match(/^\[Recovery\] Finish incomplete cleanup for branch (.+) in (.+)$/);
  if (origin?.subsystem === 'repository-cleanup' && origin.parentAgentId && repoMatch) {
    return thread.title === `[Recovery] Finish incomplete cleanup for branch ${repoMatch[1]}`
      && thread.nextAction === 'Let the recovery task finish, then verify the branch and worktree are clean.';
  }
  // The older warning producer had no recoveryOrigin. Its complete task and
  // context signatures provide provenance; never infer it from a title alone.
  const warningMatch = task.description?.match(/^\[Recovery\] (?:Resolve merge conflict and clean up stale branch|Investigate and retry failed (?:PR|MR) for branch) (\S+) in (.+)$/);
  return Boolean(task.metadata?.isRecovery === true && warningMatch
    && /^An agent (?:failed to auto-merge branch|pushed branch) "/.test(task.metadata?.context || '')
    && /Original agent: .+, original task: .+\.$/.test(task.metadata?.context || '')
    && thread.title === `Agent cleanup issue: ${warningMatch[2]}`
    && thread.nextAction === 'Let the recovery task resolve the cleanup warning, then verify the worktree.');
}

/** Recoverable archive only: preserves content, refs and unresolved CoS work.
 * Default dry run returns aggregate evidence suitable for logs or issue reports.
 * A queued per-record recheck prevents clobbering a concurrent personal edit.
 */
export async function reconcileCleanupThreads({ dryRun = true } = {}) {
  const { getTaskById } = await import('./cosTaskStore.js');
  const threads = await brainStorage.getThreads();
  let candidates = 0;
  let archived = 0;
  for (const thread of threads) {
    if (thread.source !== 'cos' || thread.status !== 'open' || thread.refs?.length !== 1
      || thread.refs[0]?.kind !== TASK_REF_KIND) continue;
    const task = await getTaskById(thread.refs[0].id);
    if (!legacyCleanupThread(thread, task)) continue;
    candidates++;
    if (dryRun) continue;
    const updated = await brainStorage.updateWith('threads', thread.id, async fresh => {
      const liveTask = await getTaskById(thread.refs[0].id);
      if (!legacyCleanupThread(fresh, liveTask)) return null;
      return { status: 'archived', cleanupReconciliation: { producer: 'cos-cleanup-v1',
        taskId: liveTask.id, archivedAt: new Date().toISOString(), reason: 'machine-owned-obligation' } };
    });
    if (updated) archived++;
  }
  return { dryRun, candidates, archived };
}
