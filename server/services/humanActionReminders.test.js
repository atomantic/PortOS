import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./brainStorage.js', () => ({ brainEvents: { on: vi.fn(), off: vi.fn() }, getThreads: vi.fn(), updateWith: vi.fn() }));
vi.mock('./eventScheduler.js', () => ({ schedule: vi.fn(), cancel: vi.fn() }));
vi.mock('./notifications.js', () => ({ addNotification: vi.fn(), NOTIFICATION_TYPES: { ACTION_DUE: 'action_due' } }));

import {
  _fireHumanActionReminder as fireHumanActionReminder,
  _reconcileHumanActionReminders as reconcileHumanActionReminders,
  _stopHumanActionReminders as stopHumanActionReminders,
} from './humanActionReminders.js';

const NOW = Date.parse('2026-10-06T18:00:00.000Z');
const ME = 'instance-a';

// A thread store with updateWith's contract: writes to one record queue
// behind each other, fn sees the fresh record, its partial is merged in, and
// null leaves the record alone.
function fakeStore(threads) {
  const byId = new Map(threads.map((t) => [t.id, { ...t }]));
  let tail = Promise.resolve();
  const write = async (id, fn) => {
    const fresh = byId.get(id);
    if (!fresh) return null;
    const updates = await fn({ ...fresh });
    if (!updates) return null;
    byId.set(id, { ...fresh, ...updates });
    return byId.get(id);
  };
  return {
    byId,
    getThreads: vi.fn(async () => [...byId.values()]),
    updateWith: vi.fn((_type, id, fn) => {
      const result = tail.then(() => write(id, fn));
      tail = result.catch(() => {});
      return result;
    }),
  };
}

const step = (overrides = {}) => ({
  id: 'step-1', title: 'Post the clip', status: 'open', priority: 'high', nextAction: 'Open X',
  tags: ['human-action'], originInstanceId: ME, dueAt: '2026-10-06T19:00:00.000Z', ...overrides,
});

const depsFor = (storage) => ({
  storage,
  scheduler: { schedule: vi.fn(), cancel: vi.fn() },
  addNotification: vi.fn(async () => ({})),
  now: () => NOW,
  instanceId: ME,
});

describe('human action reminders', () => {
  beforeEach(() => stopHumanActionReminders());

  it('arms future steps, catches up a due one once, and skips steps another machine created', async () => {
    const storage = fakeStore([
      step(),
      step({ id: 'due', title: 'Answer replies', dueAt: '2026-10-06T17:30:00.000Z', priority: 'normal' }),
      step({ id: 'peer', originInstanceId: 'instance-b', dueAt: '2026-10-06T17:30:00.000Z' }),
    ]);
    const deps = depsFor(storage);

    expect(await reconcileHumanActionReminders(deps)).toEqual({ armed: 1, fired: 1 });
    expect(deps.scheduler.schedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'human-action-due:step-1', type: 'once', delayMs: 60 * 60 * 1000 }));
    expect(deps.addNotification).toHaveBeenCalledTimes(1);
    expect(deps.addNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'action_due', title: 'Time to: Answer replies', priority: 'medium', link: '/brain/threads?thread=due',
    }));
    expect(storage.byId.get('due').remindedFor).toBe('2026-10-06T17:30:00.000Z');

    // A restart (or the write the stamp itself triggers) neither repeats the
    // reminder nor re-arms the unchanged timer.
    expect(await reconcileHumanActionReminders(deps)).toEqual({ armed: 1, fired: 0 });
    expect(deps.addNotification).toHaveBeenCalledTimes(1);
    expect(deps.scheduler.schedule).toHaveBeenCalledTimes(1);
  });

  it('disarms a step that was finished and re-arms one whose due time moved', async () => {
    const storage = fakeStore([step()]);
    const deps = depsFor(storage);
    await reconcileHumanActionReminders(deps);

    storage.byId.set('step-1', { ...storage.byId.get('step-1'), dueAt: '2026-10-06T20:00:00.000Z' });
    await reconcileHumanActionReminders(deps);
    expect(deps.scheduler.schedule).toHaveBeenLastCalledWith(expect.objectContaining({ delayMs: 2 * 60 * 60 * 1000 }));

    storage.byId.set('step-1', { ...storage.byId.get('step-1'), status: 'done' });
    await reconcileHumanActionReminders(deps);
    expect(deps.scheduler.cancel).toHaveBeenCalledWith('human-action-due:step-1');
  });

  it('notifies once when the timer and a catch-up fire for the same step', async () => {
    const storage = fakeStore([step({ dueAt: '2026-10-06T17:59:00.000Z' })]);
    const deps = depsFor(storage);
    const fired = await Promise.all([fireHumanActionReminder('step-1', deps), fireHumanActionReminder('step-1', deps)]);
    expect(fired.filter(Boolean)).toHaveLength(1);
    expect(deps.addNotification).toHaveBeenCalledTimes(1);
  });
});
