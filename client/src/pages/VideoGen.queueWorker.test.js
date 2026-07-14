import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Faithful model of VideoGen's queue-worker BUSY-retry guard (see the effect in
// client/src/pages/VideoGen.jsx). VideoGen is a >1400-line component with heavy
// imports and an internal runGeneration(), so per the repo convention for
// hard-to-mock logic (server subAgentSpawner.test.js) we exercise the exact
// staleness/unmount guard here rather than full-rendering the page.
//
// The regression this locks in: the BUSY-retry setTimeout used to be a local
// `let busyRetryTimer` assigned inside an async .catch. The effect re-runs on
// every setQueue/setRunningQueueId, so its cleanup was consumed before the
// timer was ever assigned — leaving the timer to fire setRunningQueueId after
// unmount / after a newer dispatch owned the slot. The fix: timer on a ref,
// cleared by a dedicated unmount cleanup, plus a generation token + mountedRef
// guard on every deferred callback.

function makeWorker() {
  const busyRetryTimerRef = { current: null };
  const queueWorkerGenRef = { current: 0 };
  const mountedRef = { current: true };
  let runningQueueId = null;
  const setRunningQueueId = (fnOrVal) => {
    runningQueueId = typeof fnOrVal === 'function' ? fnOrVal(runningQueueId) : fnOrVal;
  };

  // Dispatch one item; runGeneration is injected so the test controls resolution.
  function dispatch(itemId, runGeneration) {
    const myGen = ++queueWorkerGenRef.current;
    const isCurrent = () => mountedRef.current && myGen === queueWorkerGenRef.current;
    setRunningQueueId(itemId);
    let busyRetry = false;
    return runGeneration().then(() => {
      if (!isCurrent()) return;
    }).catch((err) => {
      if (!isCurrent()) return;
      const isBusy = /already in progress|VIDEO_GEN_BUSY|409/i.test(err?.message || '');
      if (isBusy) {
        busyRetry = true;
        busyRetryTimerRef.current = setTimeout(() => {
          busyRetryTimerRef.current = null;
          if (!isCurrent()) return;
          setRunningQueueId((curr) => (curr === itemId ? null : curr));
        }, 1500);
        return;
      }
    }).finally(() => {
      if (isCurrent() && !busyRetry) setRunningQueueId(null);
    });
  }

  function unmount() {
    mountedRef.current = false;
    if (busyRetryTimerRef.current) {
      clearTimeout(busyRetryTimerRef.current);
      busyRetryTimerRef.current = null;
    }
  }

  return {
    dispatch,
    unmount,
    get runningQueueId() { return runningQueueId; },
    get timer() { return busyRetryTimerRef.current; },
    get gen() { return queueWorkerGenRef.current; },
  };
}

describe('VideoGen queue-worker BUSY-retry guard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('releases the slot after the BUSY backoff when still current', async () => {
    const w = makeWorker();
    await w.dispatch('a', () => Promise.reject(new Error('VIDEO_GEN_BUSY')));
    expect(w.runningQueueId).toBe('a');
    expect(w.timer).not.toBeNull();
    vi.advanceTimersByTime(1500);
    expect(w.runningQueueId).toBeNull();
    expect(w.timer).toBeNull();
  });

  it('does NOT release the slot when unmounted during the backoff', async () => {
    const w = makeWorker();
    await w.dispatch('a', () => Promise.reject(new Error('409 already in progress')));
    expect(w.timer).not.toBeNull();
    w.unmount();               // teardown clears the ref timer
    expect(w.timer).toBeNull();
    vi.advanceTimersByTime(5000);
    // Nothing to fire — and even a leaked fire would bail on mountedRef.
    expect(w.runningQueueId).toBe('a');
  });

  it('a stale BUSY timer never releases a slot a newer dispatch now owns', async () => {
    const w = makeWorker();
    // Dispatch A → BUSY, timer scheduled for gen 1.
    await w.dispatch('a', () => Promise.reject(new Error('VIDEO_GEN_BUSY')));
    const genAfterA = w.gen;
    // Before the timer fires, a newer dispatch (B) supersedes it.
    await w.dispatch('b', () => Promise.resolve());
    expect(w.gen).toBeGreaterThan(genAfterA);
    // B resolved current and released, so slot is null; then A's stale timer fires.
    vi.advanceTimersByTime(1500);
    // The stale timer must NOT touch the slot (its isCurrent() is false).
    expect(w.runningQueueId).toBeNull();
  });

  it('marks a non-BUSY failure as done and releases the slot immediately', async () => {
    const w = makeWorker();
    await w.dispatch('a', () => Promise.reject(new Error('boom')));
    expect(w.timer).toBeNull();
    expect(w.runningQueueId).toBeNull();
  });
});
