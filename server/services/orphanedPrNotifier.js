/**
 * Orphaned-PR notifier.
 *
 * A review-loop / merge follow-up task (`spawnReviewLoopFollowUp`) exists for
 * exactly one reason: to land the pull request named in its `reviewLoopPRUrl`.
 * Blocking one is therefore not the self-contained "a task got parked" outcome
 * an ordinary block is — the PR, its branch, and its worktree are left with
 * nothing in the system that will ever merge them, and the Blocked list is the
 * only trace.
 *
 * Nothing sweeps them up afterwards, either: `app-unresolved` (the category that
 * produced the incident this was written for) sits in BOTH
 * `PAUSED_BLOCKED_CATEGORIES` and `USER_DECISION_BLOCKED_CATEGORIES`, so the
 * failure reaper never expires it and the investigation auto-retry never revives
 * it. The PR stays open indefinitely.
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
    description: `Task ${task.id} was going to land ${prUrl}, but ${why} `
      + `Nothing else will merge this PR — land it manually, or fix the block and re-run the task.`,
    priority: PRIORITY_LEVELS.HIGH,
    link: prUrl,
    metadata: { taskId: task.id, prUrl, prBranch: task.metadata?.reviewLoopPRBranch },
  });
  return true;
}
