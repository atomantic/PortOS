/**
 * Orphaned-PR notifier.
 *
 * A review-loop / merge follow-up task (`spawnReviewLoopFollowUp`) exists for
 * exactly one reason: to land the pull request named in its `reviewLoopPRUrl`.
 * Blocking one can leave the PR, its branch, and its worktree with no active
 * merge follow-up. The development watchdog rechecks the forge and retires the
 * task if the PR has already become terminal; while it remains open and the
 * follow-up remains blocked, the user needs the blocker and PR link to decide
 * what to do.
 *
 * Some block categories are deliberate user decisions, so the investigation
 * retry and failure reaper leave them alone. A blocked follow-up can therefore
 * outlive a PR that was merged or closed externally; developmentWatchdog owns
 * that forge-state reconciliation.
 *
 * Keyed on the `pending|in_progress|… → blocked` TRANSITION off the shared
 * `tasks:changed` event rather than hung off one blocking call site: ~12 sites
 * across agentErrorAnalysis / agentManagement / agentLifecycle / agentFinalization
 * / cosTaskGenerator / agentWorkspacePrep set `status: 'blocked'`, and a follow-up
 * blocked by `max-retries` or `worktree-failed` strands its PR exactly as hard as
 * one blocked by `app-unresolved`. One listener covers all of them, and stays
 * correct as new blocking paths are added.
 */

import { addNotification, exists as notificationExists, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';
import { TIMED_COOLDOWN_BLOCKED_CATEGORIES } from '../lib/taskBlockCategories.js';
import { ensureTaskThread } from './brainTaskThreads.js';

/**
 * Raise a notification when a task that was going to merge a PR gets blocked.
 *
 * Self-guarding: returns `false` without side effects unless the task is a
 * genuine block transition carrying a PR url. A notification-store failure
 * rejects rather than being swallowed here, so the caller decides — the
 * `tasks:changed` listener in cos.js logs it, because a throw from an event
 * listener has no request lifecycle to bubble to.
 *
 * @param {{ task?: object, previousStatus?: string }} change - a `tasks:changed` payload
 * @returns {Promise<boolean>} whether a notification was raised
 */
export async function notifyIfPrLeftOrphaned({ task, previousStatus } = {}) {
  if (task?.status !== 'blocked' || previousStatus === 'blocked') return false;
  const prUrl = task.metadata?.reviewLoopPRUrl;
  if (!prUrl) return false;
  // A TIMED pause is not an orphaning: the cooldown sweeper flips the task back
  // to `pending` on its own, so the PR still has something coming for it. Staying
  // quiet matters twice over — the card would be wrong, and the one-per-PR guard
  // below would then swallow the card for a REAL block that followed (the
  // `worktree-busy` wait gives up after a bounded number of attempts and re-blocks
  // as `worktree-failed`, which is the block a human actually needs to see).
  if (TIMED_COOLDOWN_BLOCKED_CATEGORIES.has(task.metadata?.blockedCategory)) return false;
  // One notification per PR, not per block. Fixing the cause and re-running is
  // the intended recovery, and a re-run that blocks again would otherwise stack
  // another HIGH card for a PR the user is already looking at.
  if (await notificationExists(NOTIFICATION_TYPES.AGENT_WARNING, 'prUrl', prUrl)) return false;
  const why = task.metadata?.blockedReason || `it was blocked (${task.metadata?.blockedCategory || 'no category'}).`;
  await addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    title: 'PR left open: its merge follow-up was blocked',
    description: `The merge follow-up task ${task.id} is blocked: ${why} PR: ${prUrl}. `
      + `If the PR is still open, fix the blocker and re-run the task or merge it manually.`,
    priority: PRIORITY_LEVELS.HIGH,
    link: prUrl,
    metadata: { taskId: task.id, prUrl, prBranch: task.metadata?.reviewLoopPRBranch },
  });
  await ensureTaskThread({
    taskId: task.id,
    title: 'PR left open: its merge follow-up was blocked',
    nextAction: 'Check the linked PR. If it is still open, fix the blocker and re-run the task or merge it manually.',
    notes: `${prUrl}\n${why}`,
    priority: 'high',
  });
  return true;
}
