import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PYTHON_NOISE_RE,
  SSE_CLEANUP_DELAY_MS,
  broadcastSse,
  attachSseClient,
  closeJobAfterDelay,
  createSseRunner
} from './sseUtils.js';

const makeRes = () => {
  const writes = [];
  const closeListeners = [];
  return {
    writes,
    closeListeners,
    writeHead: vi.fn(),
    write: vi.fn((msg) => writes.push(msg)),
    end: vi.fn(),
    req: {
      on: vi.fn((event, fn) => {
        if (event === 'close') closeListeners.push(fn);
      })
    }
  };
};

describe('PYTHON_NOISE_RE', () => {
  it('matches noisy framework warnings', () => {
    expect(PYTHON_NOISE_RE.test('xformers warning')).toBe(true);
    expect(PYTHON_NOISE_RE.test('UserWarning: deprecated')).toBe(true);
    expect(PYTHON_NOISE_RE.test('FutureWarning')).toBe(true);
    expect(PYTHON_NOISE_RE.test('DeprecationWarning')).toBe(true);
    expect(PYTHON_NOISE_RE.test('Set XFORMERS=1')).toBe(true);
    expect(PYTHON_NOISE_RE.test('NOTE: Redirects to ...')).toBe(true);
  });

  it('does not match real progress messages', () => {
    expect(PYTHON_NOISE_RE.test('Step 5/30')).toBe(false);
    expect(PYTHON_NOISE_RE.test('Generated image')).toBe(false);
    expect(PYTHON_NOISE_RE.test('100% complete')).toBe(false);
  });
});

describe('broadcastSse', () => {
  it('writes data: JSON\\n\\n format to all clients and caches lastPayload', () => {
    const c1 = makeRes();
    const c2 = makeRes();
    const job = { clients: [c1, c2] };
    const payload = { progress: 0.5, step: 5 };
    broadcastSse(job, payload);

    const expected = `data: ${JSON.stringify(payload)}\n\n`;
    expect(c1.write).toHaveBeenCalledWith(expected);
    expect(c2.write).toHaveBeenCalledWith(expected);
    expect(job.lastPayload).toEqual(payload);
  });

  it('handles empty client list without error', () => {
    const job = { clients: [] };
    broadcastSse(job, { ok: true });
    expect(job.lastPayload).toEqual({ ok: true });
  });
});

describe('attachSseClient', () => {
  it('returns false when jobId not found', () => {
    const jobs = new Map();
    const res = makeRes();
    expect(attachSseClient(jobs, 'missing', res)).toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('writes SSE headers and pushes res into job clients', () => {
    const jobs = new Map();
    const job = { clients: [] };
    jobs.set('j1', job);
    const res = makeRes();

    expect(attachSseClient(jobs, 'j1', res)).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }));
    expect(job.clients).toContain(res);
  });

  it('replays lastPayload to a late-joining client', () => {
    const jobs = new Map();
    const lastPayload = { state: 'complete' };
    jobs.set('j1', { clients: [], lastPayload });
    const res = makeRes();

    attachSseClient(jobs, 'j1', res);

    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify(lastPayload)}\n\n`);
  });

  it('skips replay when no lastPayload exists', () => {
    const jobs = new Map();
    jobs.set('j1', { clients: [] });
    const res = makeRes();

    attachSseClient(jobs, 'j1', res);
    expect(res.write).not.toHaveBeenCalled();
  });

  it('removes client from job.clients on req close', () => {
    const jobs = new Map();
    const job = { clients: [] };
    jobs.set('j1', job);
    const res = makeRes();

    attachSseClient(jobs, 'j1', res);
    expect(job.clients).toHaveLength(1);

    for (const fn of res.closeListeners) fn();
    expect(job.clients).toHaveLength(0);
  });
});

describe('closeJobAfterDelay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ends each client and deletes job after delay', () => {
    const jobs = new Map();
    const c1 = makeRes();
    const c2 = makeRes();
    jobs.set('j1', { clients: [c1, c2] });

    closeJobAfterDelay(jobs, 'j1', 100);
    expect(jobs.has('j1')).toBe(true);

    vi.advanceTimersByTime(100);
    expect(c1.end).toHaveBeenCalled();
    expect(c2.end).toHaveBeenCalled();
    expect(jobs.has('j1')).toBe(false);
  });

  it('uses the default SSE_CLEANUP_DELAY_MS when no delay is specified', () => {
    const jobs = new Map();
    jobs.set('j1', { clients: [] });

    closeJobAfterDelay(jobs, 'j1');
    vi.advanceTimersByTime(SSE_CLEANUP_DELAY_MS - 1);
    expect(jobs.has('j1')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(jobs.has('j1')).toBe(false);
  });

  it('no-ops gracefully when job already removed', () => {
    const jobs = new Map();
    closeJobAfterDelay(jobs, 'missing', 10);
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
  });

  it('leaves a replacement job untouched when expectedJob no longer holds the key', () => {
    const jobs = new Map();
    const stale = { clients: [makeRes()] };
    const fresh = { clients: [makeRes()] };
    jobs.set('j1', stale);

    // Schedule cleanup for `stale`, then a new run replaces it under the same key.
    closeJobAfterDelay(jobs, 'j1', 100, stale);
    jobs.set('j1', fresh);

    vi.advanceTimersByTime(100);
    // The stale run's lingering client is drained, but the live entry survives.
    expect(stale.clients[0].end).toHaveBeenCalled();
    expect(fresh.clients[0].end).not.toHaveBeenCalled();
    expect(jobs.get('j1')).toBe(fresh);
  });

  it('deletes the job when expectedJob still holds the key', () => {
    const jobs = new Map();
    const job = { clients: [makeRes()] };
    jobs.set('j1', job);

    closeJobAfterDelay(jobs, 'j1', 100, job);
    vi.advanceTimersByTime(100);
    expect(job.clients[0].end).toHaveBeenCalled();
    expect(jobs.has('j1')).toBe(false);
  });
});

describe('createSseRunner', () => {
  // Flush the microtask queue enough times for the fire-and-forget IIFE
  // (try → await work → finally) to settle. Real promises are not faked even
  // when timers are.
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  // A never-settling promise keeps a run "in flight" for the duration of a test
  // without leaking a pending timer.
  const pending = () => new Promise(() => {});

  it('start returns a runId, registers the run, and reports it active', () => {
    const runner = createSseRunner({ logLabel: 'test' });
    const { runId, alreadyRunning } = runner.start('k1', () => pending());

    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);
    expect(alreadyRunning).toBe(false);
    expect(runner.runs.has('k1')).toBe(true);
    expect(runner.isActive('k1')).toBe(true);
  });

  it('a second start while one is in flight resolves to the existing runId without re-running work', () => {
    const runner = createSseRunner({ logLabel: 'test' });
    const first = runner.start('k1', () => pending());
    const work2 = vi.fn(() => pending());
    const second = runner.start('k1', work2);

    expect(second.runId).toBe(first.runId);
    expect(second.alreadyRunning).toBe(true);
    expect(work2).not.toHaveBeenCalled();
  });

  it('broadcasts frames to attached clients and caches the last frame for replay', async () => {
    const runner = createSseRunner({ logLabel: 'test' });
    let release;
    const gate = new Promise((r) => { release = r; });
    runner.start('k1', async ({ broadcast }) => {
      broadcast({ type: 'start' });
      await gate;
      broadcast({ type: 'complete' });
    });

    // A client that attaches after `start` fired still replays the cached frame.
    const res = makeRes();
    runner.attachClient('k1', res);
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

    release();
    await flush();
    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
  });

  it('cancel flags the record, aborts the signal, and returns false for an unknown key', () => {
    const runner = createSseRunner({ logLabel: 'test' });
    let captured;
    runner.start('k1', ({ signal, record }) => {
      captured = { signal, record };
      return pending();
    });

    expect(runner.cancel('k1')).toBe(true);
    expect(captured.record.cancelRequested).toBe(true);
    expect(captured.signal.aborted).toBe(true);
    expect(runner.cancel('missing')).toBe(false);
  });

  it('a thrown error emits an error frame and logs, then the run is no longer active', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createSseRunner({ logLabel: 'widget run' });
    const res = makeRes();
    runner.start('k1', async ({ broadcast }) => {
      // Attach happens inside work so the client receives the error frame live.
      runner.attachClient('k1', res);
      throw new Error('boom');
    });

    await flush();
    const errorWrite = res.write.mock.calls.find(([m]) => m.includes('"type":"error"'));
    expect(errorWrite).toBeTruthy();
    expect(errorWrite[0]).toContain('boom');
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('widget run failed'));
    expect(runner.isActive('k1')).toBe(false);
    errSpy.mockRestore();
  });

  it('a finished run lingers for replay then is evicted after SSE_CLEANUP_DELAY_MS', async () => {
    vi.useFakeTimers();
    const runner = createSseRunner({ logLabel: 'test' });
    runner.start('k1', async ({ broadcast }) => { broadcast({ type: 'complete' }); });

    await flush();
    expect(runner.isActive('k1')).toBe(false); // finished
    expect(runner.runs.has('k1')).toBe(true);  // but still mapped for replay

    vi.advanceTimersByTime(SSE_CLEANUP_DELAY_MS);
    expect(runner.runs.has('k1')).toBe(false);
    vi.useRealTimers();
  });

  it('restarting within the replay window cancels the old eviction and replaces the run', async () => {
    vi.useFakeTimers();
    const runner = createSseRunner({ logLabel: 'test' });
    const first = runner.start('k1', async ({ broadcast }) => { broadcast({ type: 'complete' }); });
    await flush();
    expect(runner.runs.has('k1')).toBe(true);

    // Re-run before the eviction timer fires — should fully replace the record.
    const second = runner.start('k1', () => pending());
    expect(second.runId).not.toBe(first.runId);
    expect(second.alreadyRunning).toBe(false);
    expect(runner.isActive('k1')).toBe(true);

    // The first run's eviction timer must NOT evict the live replacement.
    vi.advanceTimersByTime(SSE_CLEANUP_DELAY_MS);
    expect(runner.runs.get('k1')?.runId).toBe(second.runId);
    vi.useRealTimers();
  });
});
