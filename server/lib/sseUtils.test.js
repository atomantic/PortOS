import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PYTHON_NOISE_RE,
  SSE_CLEANUP_DELAY_MS,
  broadcastSse,
  attachSseClient,
  closeJobAfterDelay
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
});
