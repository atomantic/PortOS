import { describe, expect, it, vi, afterEach } from 'vitest';
import { createStaleWhileRevalidate, PENDING, WAIT } from './staleWhileRevalidate.js';

afterEach(() => { vi.useRealTimers(); });

const TTL = 60_000;

describe('createStaleWhileRevalidate', () => {
  it('caches within the TTL and folds concurrent callers into one production', async () => {
    const cache = createStaleWhileRevalidate({ ttlMs: TTL });
    const produce = vi.fn().mockResolvedValue('a');
    const [one, two] = await Promise.all([
      cache.read('k', produce),
      cache.read('k', produce),
    ]);
    expect([one, two]).toEqual(['a', 'a']);
    expect(await cache.read('k', produce)).toBe('a');
    expect(produce).toHaveBeenCalledTimes(1);
  });

  // The point of the whole module: a caller must never pay for a slow producer
  // just because a timer lapsed.
  it('serves a STALE value immediately and revalidates behind the caller', async () => {
    vi.useFakeTimers();
    const cache = createStaleWhileRevalidate({ ttlMs: TTL });
    await cache.read('k', () => Promise.resolve('old'));

    vi.advanceTimersByTime(TTL + 1);
    let release;
    const slow = () => new Promise((resolve) => { release = resolve; });
    // A blocking cache would hang here — this producer never settles on its own.
    expect(await cache.read('k', slow)).toBe('old');

    release('new');
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.read('k', slow)).toBe('new');
  });

  it("returns PENDING on a cold cache under wait:'never', and starts the production", async () => {
    const cache = createStaleWhileRevalidate({ ttlMs: TTL });
    let release;
    const produce = vi.fn(() => new Promise((resolve) => { release = resolve; }));

    expect(await cache.read('k', produce, { wait: WAIT.NEVER })).toBe(PENDING);
    release('a');
    await vi.waitFor(async () => {
      expect(await cache.read('k', produce, { wait: WAIT.NEVER })).toBe('a');
    });
    expect(produce).toHaveBeenCalledTimes(1); // started once, not per poll
  });

  it("wait:'fresh' bypasses a perfectly fresh value and waits for a live one", async () => {
    const cache = createStaleWhileRevalidate({ ttlMs: TTL });
    await cache.read('k', () => Promise.resolve('old'));
    expect(await cache.read('k', () => Promise.resolve('new'), { wait: WAIT.FRESH })).toBe('new');
  });

  // A transient failure must not flip a healthy reading to an error state.
  it('keeps the last good value when a revalidation fails', async () => {
    vi.useFakeTimers();
    const cache = createStaleWhileRevalidate({ ttlMs: TTL });
    await cache.read('k', () => Promise.resolve('good'));

    vi.advanceTimersByTime(TTL + 1);
    expect(await cache.read('k', () => Promise.reject(new Error('boom')))).toBe('good');
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.read('k', () => Promise.reject(new Error('boom')))).toBe('good');
  });

  // Without the backoff, "serve stale + revalidate" becomes "start a new
  // subprocess on every request" exactly when the subprocess is broken.
  it('backs off instead of re-running a producer that just failed', async () => {
    vi.useFakeTimers();
    const cache = createStaleWhileRevalidate({ ttlMs: TTL, failureBackoffMs: 30_000 });
    await cache.read('k', () => Promise.resolve('good'));
    vi.advanceTimersByTime(TTL + 1);

    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    await cache.read('k', failing);
    await vi.advanceTimersByTimeAsync(0);

    // Three more reads inside the backoff window: still one attempt total.
    for (let i = 0; i < 3; i += 1) await cache.read('k', failing);
    expect(failing).toHaveBeenCalledTimes(1);

    // Past the window it tries again.
    vi.advanceTimersByTime(30_001);
    await cache.read('k', failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  // PENDING promises a reading that is coming. When production has already
  // failed with nothing cached, it isn't — so a poller would never stop.
  it('throws rather than answering PENDING when a cold production has failed', async () => {
    vi.useFakeTimers();
    const cache = createStaleWhileRevalidate({ ttlMs: TTL, failureBackoffMs: 30_000 });
    const failing = vi.fn().mockRejectedValue(new Error('boom'));

    expect(await cache.read('k', failing, { wait: WAIT.NEVER })).toBe(PENDING);
    await vi.advanceTimersByTimeAsync(0);
    await expect(cache.read('k', failing, { wait: WAIT.NEVER })).rejects.toThrow(/backing off/);
  });

  it('propagates the error to a caller that chose to wait', async () => {
    const cache = createStaleWhileRevalidate({ ttlMs: TTL });
    await expect(cache.read('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  // A degraded-but-successful reading is still cached — not caching it at all is
  // what turns every poll into a fresh spawn — it just expires sooner.
  it('gives an incomplete reading the short TTL so the next view self-heals', async () => {
    vi.useFakeTimers();
    const cache = createStaleWhileRevalidate({
      ttlMs: TTL, partialTtlMs: 1000, isComplete: (v) => v !== 'partial',
    });
    const produce = vi.fn().mockResolvedValueOnce('partial').mockResolvedValueOnce('full');

    expect(await cache.read('k', produce)).toBe('partial');
    vi.advanceTimersByTime(500);
    expect(await cache.read('k', produce)).toBe('partial'); // still inside the short TTL
    expect(produce).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(600); // past partialTtlMs, far short of ttlMs
    expect(await cache.read('k', produce)).toBe('partial'); // stale-served…
    await vi.advanceTimersByTimeAsync(0);
    expect(await cache.read('k', produce)).toBe('full'); // …and revalidated
  });

  it('keeps a settled reading usable when its synchronous notification throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cache = createStaleWhileRevalidate({
        ttlMs: TTL, onSettled: () => { throw new Error('example listener failure'); },
      });
      const produce = vi.fn().mockResolvedValue('reading');
      expect(await cache.read('k', produce)).toBe('reading');
      expect(await cache.read('k', produce)).toBe('reading');
      expect(produce).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('keys entries independently and clears them', async () => {
    const cache = createStaleWhileRevalidate({ ttlMs: TTL });
    await cache.read('a', () => Promise.resolve(1));
    await cache.read('b', () => Promise.resolve(2));
    expect(await cache.read('a', () => Promise.resolve(99))).toBe(1);

    cache.clear('a');
    expect(await cache.read('a', () => Promise.resolve(99))).toBe(99);
    expect(await cache.read('b', () => Promise.resolve(99))).toBe(2);

    cache.clear();
    expect(await cache.read('b', () => Promise.resolve(99))).toBe(99);
  });
});
