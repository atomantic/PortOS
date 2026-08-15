/**
 * Tests for orphanedPrNotifier — the `tasks:changed → blocked` listener that
 * surfaces a pull request whose merge follow-up got parked.
 *
 * The contract these pin: it fires on the TRANSITION into blocked (not the
 * level), only for a task carrying `reviewLoopPRUrl`, and only once per PR.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./notifications.js', () => ({
  addNotification: vi.fn().mockResolvedValue({}),
  exists: vi.fn().mockResolvedValue(false),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));

import { notifyIfPrLeftOrphaned } from './orphanedPrNotifier.js';
import { addNotification, exists } from './notifications.js';

const PR_URL = 'https://github.com/example-org/example-repo/pull/9';

const followUp = (metadata = {}) => ({
  id: 'sys-rl-1',
  status: 'blocked',
  metadata: {
    reviewLoopFollowUp: true,
    reviewLoopPRUrl: PR_URL,
    reviewLoopPRBranch: 'cos/task-1/agent-1',
    blockedReason: "App 'null' didn't resolve to a repository directory.",
    blockedCategory: 'app-unresolved',
    ...metadata,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  exists.mockResolvedValue(false);
});

describe('notifyIfPrLeftOrphaned', () => {
  it('notifies with the PR url when a merge follow-up transitions into blocked', async () => {
    const raised = await notifyIfPrLeftOrphaned({ task: followUp(), previousStatus: 'pending' });
    expect(raised).toBe(true);
    expect(addNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent_warning',
      priority: 'high',
      link: PR_URL,
      description: expect.stringContaining(PR_URL),
      metadata: expect.objectContaining({
        taskId: 'sys-rl-1', prUrl: PR_URL, prBranch: 'cos/task-1/agent-1',
      }),
    }));
    // The block's own explanation is what tells the user how to unstick it.
    expect(addNotification.mock.calls[0][0].description).toContain("didn't resolve");
  });

  // ~12 sites set `status: 'blocked'`; a follow-up blocked by max-retries or a
  // failed worktree strands its PR exactly as hard as an unresolved app does.
  it('fires for any blocking category, not just app-unresolved', async () => {
    const task = followUp({ blockedCategory: 'max-retries', blockedReason: 'Task failed 3 times.' });
    expect(await notifyIfPrLeftOrphaned({ task, previousStatus: 'in_progress' })).toBe(true);
  });

  it('falls back to the category when the block carries no reason', async () => {
    const task = followUp({ blockedReason: undefined, blockedCategory: 'worktree-failed' });
    await notifyIfPrLeftOrphaned({ task, previousStatus: 'pending' });
    expect(addNotification.mock.calls[0][0].description).toContain('worktree-failed');
  });

  // ...but a TIMED pause is not an orphaning: the cooldown sweeper revives it.
  // The one-per-PR guard makes this load-bearing — a card raised for the pause
  // would swallow the card for the real block the task lands on if it gives up.
  it('stays quiet for a self-reviving cooldown block', async () => {
    const task = followUp({
      blockedCategory: 'worktree-busy',
      blockedReason: 'Branch cos/task-1/agent-1 is still checked out in another worktree',
      cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await notifyIfPrLeftOrphaned({ task, previousStatus: 'pending' })).toBe(false);
    expect(addNotification).not.toHaveBeenCalled();
    // The cooldown check must come before the dedupe probe, or the pause would
    // still consume the one card this PR gets.
    expect(exists).not.toHaveBeenCalled();
  });

  it('ignores an ordinary blocked task that is not landing a PR', async () => {
    const task = { id: 't-plain', status: 'blocked', metadata: { blockedCategory: 'app-unresolved' } };
    expect(await notifyIfPrLeftOrphaned({ task, previousStatus: 'pending' })).toBe(false);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('ignores a task that is not blocked', async () => {
    const task = { ...followUp(), status: 'pending' };
    expect(await notifyIfPrLeftOrphaned({ task, previousStatus: 'blocked' })).toBe(false);
    expect(addNotification).not.toHaveBeenCalled();
  });

  // `updateTask` re-emits `tasks:changed` on every later write to an already
  // blocked task (an edit to its description is enough) — keying on the level
  // rather than the edge would re-notify on each one.
  it('ignores a re-emit for a task that was already blocked', async () => {
    expect(await notifyIfPrLeftOrphaned({ task: followUp(), previousStatus: 'blocked' })).toBe(false);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('does not stack a second card for a PR already notified about', async () => {
    exists.mockResolvedValue(true);
    expect(await notifyIfPrLeftOrphaned({ task: followUp(), previousStatus: 'pending' })).toBe(false);
    expect(exists).toHaveBeenCalledWith('agent_warning', 'prUrl', PR_URL);
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('tolerates an empty payload', async () => {
    expect(await notifyIfPrLeftOrphaned()).toBe(false);
    expect(await notifyIfPrLeftOrphaned({})).toBe(false);
  });
});
