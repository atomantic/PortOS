import { afterEach, expect, it, vi } from 'vitest';
import { cancel, drain, getHistory, getStats, quiesce, resume, schedule, triggerNow } from './eventScheduler.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// A cancelled handler must finish its DB write before shutdown ends the pool;
// its late follow-up must also stay disarmed, even after it leaves the registry.
it('drains cancelled handlers before DB close and refuses new work during shutdown', async () => {
  vi.useFakeTimers();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let poolEnded = false;
  const query = vi.fn(() => {
    if (poolEnded) throw new Error('Cannot use a pool after calling end on the pool');
  });
  const followUp = vi.fn();
  schedule({ id: 'writing', type: 'interval', intervalMs: 100, handler: async () => {
    await gate;
    query();
    schedule({ id: 'follow-up', type: 'once', delayMs: 1, handler: followUp });
  } });
  const running = triggerNow('writing');
  cancel('writing');
  schedule({ id: 'waiting', type: 'once', delayMs: 1, handler: followUp });

  quiesce();
  quiesce();
  const closing = drain().then(() => { poolEnded = true; });
  await Promise.resolve();
  expect(poolEnded).toBe(false);
  expect(await triggerNow('waiting')).toBe(false);
  expect(resume('waiting')).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(followUp).not.toHaveBeenCalled();

  release();
  await running;
  await closing;
  await vi.advanceTimersByTimeAsync(1000);
  expect(poolEnded).toBe(true);
  expect(query).toHaveBeenCalledOnce();
  expect(followUp).not.toHaveBeenCalled();
  expect(getStats()).toMatchObject({ activeEvents: 0, activeTimers: 0 });
  expect(getHistory({ eventId: 'writing' })[0]).toMatchObject({ success: true, error: null });
  expect(errors).not.toHaveBeenCalled();
});
