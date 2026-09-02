/**
 * #5644 — the CoS scheduler fires `dequeueNextTask` from ~10 timer/setImmediate
 * callbacks. Those run outside the Express request lifecycle, so a rejection
 * inside the cycle (a corrupt `cos-state.json`, a provider-list fetch that
 * throws, a runner transport error) has nowhere to bubble: it escapes as an
 * unhandled rejection, which `setupProcessErrorHandlers` classifies
 * `severity: 'critical'` and broadcasts to every connected browser.
 *
 * This is the behavioural half of the guard (the structural half — "no bare
 * `setImmediate(() => dequeueNextTask())` is ever re-added" — lives in
 * cos.test.js). It drives the REAL listener registered by `init()` with a
 * `loadState` that rejects, and asserts each failed cycle is logged and never
 * reaches the process-level unhandled-rejection handler.
 *
 * Lives in its own file because the `cosState.js` partial mock is module-wide
 * and cos.test.js exercises the real state helpers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const STATE_ERROR = 'corrupt cos-state.json';

vi.mock('./cosState.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureDirectories: vi.fn(async () => {}),
  isDaemonRunning: () => true,
  loadState: vi.fn(async () => { throw new Error(STATE_ERROR); }),
}));

const { init } = await import('./cos.js');
const { cosEvents } = await import('./cosEvents.js');

// One macrotask turn is enough: the listener schedules with setImmediate and the
// wrapper's .catch settles on the microtask queue right after.
const drainScheduled = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scheduleDequeue — rejections stay inside the cycle (#5644)', () => {
  it('logs a rejecting dequeue cycle instead of leaking an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // init() registers the scheduler listeners, then reads state itself — that
    // trailing read is the mocked rejection, so swallow it here. The listeners
    // are already attached by then, which is what this test drives.
    await init().catch(() => {});

    // Two independent event sources, so a guard added to only one of them fails.
    cosEvents.emit('tasks:cos:added');
    cosEvents.emit('tasks:changed', { action: 'approved' });
    await drainScheduled();

    process.off('unhandledRejection', onUnhandled);

    expect(unhandled, 'no rejection may escape the scheduled callback').toEqual([]);
    const logged = errorSpy.mock.calls
      .map(args => args.join(' '))
      .filter(line => line.includes('CoS dequeue cycle failed'));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain(STATE_ERROR);
  });
});
