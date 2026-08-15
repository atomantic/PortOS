/**
 * `unblockExpiredCooldowns` — expired timed-cooldown revival (#3500).
 *
 * The pass walks BOTH task stores' blocked groups and flips any task in
 * `TIMED_COOLDOWN_BLOCKED_CATEGORIES` whose `cooldownUntil` has passed back to
 * `pending`.
 * Each revived task has to be written back to the store it came from, and the
 * pre-fix version re-derived that origin per task with
 * `userTaskData.grouped.blocked.includes(task)` — an O(N) scan inside the O(N)
 * loop. These tests pin the classification results AND that no membership scan
 * happens, so a future edit can't quietly reintroduce the quadratic lookup.
 *
 * Isolated file so the `cosTaskStore` mock can't leak into the shared
 * cosTaskGenerator suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const updateTaskMock = vi.fn(async () => ({}));
vi.mock('./cosTaskStore.js', async (importActual) => ({
  ...(await importActual()),
  updateTask: (...args) => updateTaskMock(...args),
}));

import { unblockExpiredCooldowns } from './cosTaskGenerator.js';

const EXPIRED = new Date(Date.now() - 60_000).toISOString();
const PENDING = new Date(Date.now() + 60 * 60_000).toISOString();

const cooldownTask = (id, cooldownUntil, extra = {}) => ({
  id,
  status: 'blocked',
  metadata: { blockedCategory: 'orphan-cooldown', blockedReason: 'orphaned', blockedAt: EXPIRED, cooldownUntil },
  ...extra,
});

/**
 * A blocked-group array that counts every membership scan performed against it.
 * The own `includes` property shadows `Array.prototype.includes`, so the
 * pre-fix `blocked.includes(task)` classification is directly observable.
 */
const scanCountingArray = (tasks) => {
  const arr = [...tasks];
  arr.scans = 0;
  arr.includes = function (...args) {
    arr.scans += 1;
    return Array.prototype.includes.apply(this, args);
  };
  return arr;
};

const store = (blocked) => ({ grouped: { blocked } });

beforeEach(() => {
  updateTaskMock.mockClear();
});

describe('unblockExpiredCooldowns', () => {
  it('routes each revived task back to the store it was read from', async () => {
    await unblockExpiredCooldowns(
      store([cooldownTask('u1', EXPIRED)]),
      store([cooldownTask('c1', EXPIRED)])
    );

    expect(updateTaskMock).toHaveBeenCalledTimes(2);
    expect(updateTaskMock.mock.calls.map(([id, , taskType]) => [id, taskType])).toEqual([
      ['u1', 'user'],
      ['c1', 'internal'],
    ]);
  });

  it('classifies queue origin without any membership scan (no O(N^2) lookup)', async () => {
    // Enough tasks that a per-task scan is unmistakable in the counter.
    const userBlocked = scanCountingArray(
      Array.from({ length: 25 }, (_, i) => cooldownTask(`u${i}`, EXPIRED))
    );
    const cosBlocked = scanCountingArray(
      Array.from({ length: 25 }, (_, i) => cooldownTask(`c${i}`, EXPIRED))
    );

    await unblockExpiredCooldowns(store(userBlocked), store(cosBlocked));

    expect(updateTaskMock).toHaveBeenCalledTimes(50);
    expect(userBlocked.scans).toBe(0);
    expect(cosBlocked.scans).toBe(0);
  });

  it('honors an explicit taskType over the queue default', async () => {
    // A user-typed task parked in the CoS store still writes back as 'user'.
    await unblockExpiredCooldowns(
      store([]),
      store([cooldownTask('c1', EXPIRED, { taskType: 'user' })])
    );

    expect(updateTaskMock).toHaveBeenCalledWith('c1', expect.anything(), 'user');
  });

  it('clears the block fields and flips status to pending', async () => {
    await unblockExpiredCooldowns(store([cooldownTask('u1', EXPIRED)]), store([]));

    const [, update] = updateTaskMock.mock.calls[0];
    expect(update.status).toBe('pending');
    expect(update.metadata.blockedCategory).toBeUndefined();
    expect(update.metadata.blockedReason).toBeUndefined();
    expect(update.metadata.blockedAt).toBeUndefined();
    expect(update.metadata.cooldownUntil).toBeUndefined();
  });

  it('leaves unexpired cooldowns, other block categories, and missing groups alone', async () => {
    await unblockExpiredCooldowns(
      store([
        cooldownTask('u1', PENDING),
        { id: 'u2', metadata: { blockedCategory: 'max-spawns', cooldownUntil: EXPIRED } },
        { id: 'u3', metadata: { blockedCategory: 'orphan-cooldown' } },
        { id: 'u4' },
      ]),
      {}
    );

    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  // The pass sweeps the whole TIMED_COOLDOWN_BLOCKED_CATEGORIES vocabulary, not a
  // literal `orphan-cooldown` — a category added to that set with no sweeper of
  // its own would otherwise sit blocked forever. `worktree-busy` is the second
  // member: a merge follow-up waiting for another worktree to release its branch.
  it('revives every timed-cooldown category, not just orphan-cooldown', async () => {
    await unblockExpiredCooldowns(
      store([]),
      store([{
        id: 'sys-rl-1',
        status: 'blocked',
        metadata: {
          blockedCategory: 'worktree-busy',
          cooldownUntil: EXPIRED,
          existingBranch: 'cos/task-1/agent-1',
          worktreeBusyAttempts: 1,
        },
      }])
    );

    expect(updateTaskMock).toHaveBeenCalledTimes(1);
    const [id, update] = updateTaskMock.mock.calls[0];
    expect(id).toBe('sys-rl-1');
    expect(update.status).toBe('pending');
    expect(update.metadata.blockedCategory).toBeUndefined();
    // The branch the follow-up exists to land survives the revival...
    expect(update.metadata.existingBranch).toBe('cos/task-1/agent-1');
    // ...and so does the attempt count, or the wait would never give up.
    expect(update.metadata.worktreeBusyAttempts).toBe(1);
  });

  it('leaves a task with an unparseable cooldownUntil blocked rather than reviving it', async () => {
    // NaN loses both `<=` and `>`, so writing the expiry test as the negation of
    // "still cooling" would silently unblock every malformed timestamp on the
    // next tick instead of leaving it parked for a human to look at.
    await unblockExpiredCooldowns(store([cooldownTask('u1', 'not-a-date')]), store([]));

    expect(updateTaskMock).not.toHaveBeenCalled();
  });
});
