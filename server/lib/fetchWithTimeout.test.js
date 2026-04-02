import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithTimeout } from './fetchWithTimeout.js';

describe('fetchWithTimeout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('passes through successful fetch', async () => {
    const mockResponse = { ok: true, status: 200 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));

    const result = await fetchWithTimeout('http://example.com');
    expect(result).toBe(mockResponse);
    expect(fetch).toHaveBeenCalledWith('http://example.com', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('aborts after timeout', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
      ));

      const promise = fetchWithTimeout('http://example.com', {}, 100);
      vi.advanceTimersByTime(100);

      await expect(promise).rejects.toThrow('aborted');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears timeout on success', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await fetchWithTimeout('http://example.com');
    expect(clearSpy).toHaveBeenCalled();
  });

  it('forwards options to fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await fetchWithTimeout('http://example.com', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(fetch).toHaveBeenCalledWith('http://example.com', expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } }));
  });

  it('composes caller signal with timeout signal', async () => {
    const callerController = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
    ));

    const promise = fetchWithTimeout('http://example.com', { signal: callerController.signal }, 60000);
    callerController.abort();

    await expect(promise).rejects.toThrow('aborted');
  });

  it('does not schedule a timeout when timeoutMs is 0', async () => {
    vi.useFakeTimers();
    try {
      const mockResponse = { ok: true, status: 200 };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
      const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

      const result = await fetchWithTimeout('http://example.com', {}, 0);
      expect(result).toBe(mockResponse);
      // setTimeout should not have been called for the abort timer
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts immediately when caller signal is already aborted (fallback path)', async () => {
    // Force fallback path by temporarily removing AbortSignal.any
    const origDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { value: undefined, writable: true, configurable: true });

    try {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) =>
        new Promise((_resolve, reject) => {
          // Handle already-aborted signal (event won't fire if already aborted)
          if (opts.signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
          opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
      ));

      const callerController = new AbortController();
      callerController.abort(); // Pre-abort before calling fetchWithTimeout

      await expect(fetchWithTimeout('http://example.com', { signal: callerController.signal }, 60000))
        .rejects.toThrow('aborted');
    } finally {
      if (origDescriptor) {
        Object.defineProperty(AbortSignal, 'any', origDescriptor);
      } else {
        delete AbortSignal.any;
      }
    }
  });
});
