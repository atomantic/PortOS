/**
 * `unblockExpiredOrphanCooldowns` — expired orphan-cooldown revival (#3500).
 *
 * The pass walks BOTH task stores' blocked groups and flips any
 * `orphan-cooldown` task whose `cooldownUntil` has passed back to `pending`.
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

import { unblockExpiredOrphanCooldowns } from './cosTaskGenerator.js';

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

describe('unblockExpiredOrphanCooldowns', () => {
  it('routes each revived task back to the store it was read from', async () => {
    await unblockExpiredOrphanCooldowns(
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

    await unblockExpiredOrphanCooldowns(store(userBlocked), store(cosBlocked));

    expect(updateTaskMock).toHaveBeenCalledTimes(50);
    expect(userBlocked.scans).toBe(0);
    expect(cosBlocked.scans).toBe(0);
  });

  it('honors an explicit taskType over the queue default', async () => {
    // A user-typed task parked in the CoS store still writes back as 'user'.
    await unblockExpiredOrphanCooldowns(
      store([]),
      store([cooldownTask('c1', EXPIRED, { taskType: 'user' })])
    );

    expect(updateTaskMock).toHaveBeenCalledWith('c1', expect.anything(), 'user');
  });

  it('clears the block fields and flips status to pending', async () => {
    await unblockExpiredOrphanCooldowns(store([cooldownTask('u1', EXPIRED)]), store([]));

    const [, update] = updateTaskMock.mock.calls[0];
    expect(update.status).toBe('pending');
    expect(update.metadata.blockedCategory).toBeUndefined();
    expect(update.metadata.blockedReason).toBeUndefined();
    expect(update.metadata.blockedAt).toBeUndefined();
    expect(update.metadata.cooldownUntil).toBeUndefined();
  });

  it('leaves unexpired cooldowns, other block categories, and missing groups alone', async () => {
    await unblockExpiredOrphanCooldowns(
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
});
