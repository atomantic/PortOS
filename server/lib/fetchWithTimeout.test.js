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
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it('clears timeout on success — no pending timer remains', async () => {
    // Use fake timers so we can observe that no timer is left pending after
    // a successful fetch. If clearTimeout were NOT called, advanceTimersByTime
    // would later fire the abort, which would error on an already-resolved fetch.
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
      const clearSpy = vi.spyOn(global, 'clearTimeout');

      const result = await fetchWithTimeout('http://example.com', {}, 5000);

      expect(result.status).toBe(200);
      // clearTimeout must have been called with a non-null handle.
      // Under fake timers the handle is an object, not a number; the important
      // thing is it was called (not skipped) and not with null/undefined.
      expect(clearSpy).toHaveBeenCalledTimes(1);
      const [handle] = clearSpy.mock.calls[0];
      expect(handle).not.toBeNull();
      expect(handle).not.toBeUndefined();

      // Advance past the original timeout — if the abort timer were still
      // pending this would cause an unhandled abort on a resolved promise.
      vi.advanceTimersByTime(6000);
    } finally {
      // Restore spies BEFORE leaving fake-timer mode: a spy installed while the
      // fakes were active captured the FAKE timer function as its "original",
      // so restoring it afterwards would reinstall that fake globally and
      // silently freeze every real-timer test that runs later in this file.
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
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
      // See the note above — restore spies while the fakes are still installed.
      vi.restoreAllMocks();
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
// --- Body deadline (#7236) -------------------------------------------------
  //
  // These drive REAL streams rather than plain-object doubles, because the whole
  // point is what happens between "headers resolved" and "last byte read" — a
  // double that resolves `json()` instantly cannot observe it.

  /** A Response whose headers have landed but whose body never produces a byte. */
  function stallingResponse(signal) {
    const body = new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  it('aborts a body that stalls after headers land', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, opts) => Promise.resolve(stallingResponse(opts.signal))));

    const started = Date.now();
    const res = await fetchWithTimeout('http://example.com', {}, 60);
    // Headers resolved fine — the old helper cleared its timer right here and
    // left the read below unbounded forever.
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(60 * 2 + 500);
  });

  it('aborts a stalled body read through the raw stream too', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, opts) => Promise.resolve(stallingResponse(opts.signal))));

    const res = await fetchWithTimeout('http://example.com', {}, 60);
    const reader = res.body.getReader();
    await expect(reader.read()).rejects.toThrow(/abort/i);
  });

  it('does not arm a body deadline when timeoutMs is 0', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, opts) => Promise.resolve(stallingResponse(opts.signal))));

    const res = await fetchWithTimeout('http://example.com', {}, 0);
    const settled = await Promise.race([
      res.text().then(() => 'read', () => 'aborted'),
      new Promise((resolve) => setTimeout(() => resolve('still-open'), 150)),
    ]);
    expect(settled).toBe('still-open');
  });

  it('honors bodyDeadline: false for a caller that bounds its own stream', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, opts) => Promise.resolve(stallingResponse(opts.signal))));

    const res = await fetchWithTimeout('http://example.com', {}, 60, { bodyDeadline: false });
    const settled = await Promise.race([
      res.text().then(() => 'read', () => 'aborted'),
      new Promise((resolve) => setTimeout(() => resolve('still-open'), 200)),
    ]);
    expect(settled).toBe('still-open');
  });

  it('releases the deadline once the body is fully read', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))));

    const res = await fetchWithTimeout('http://example.com', {}, 5000);
    expect(clearSpy).not.toHaveBeenCalled();  // still armed while the body is unread
    expect(await res.json()).toEqual({ ok: true });
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the deadline when the body is cancelled instead of read', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('payload', { status: 500 }))));

    const res = await fetchWithTimeout('http://example.com', {}, 5000);
    await res.body.cancel();
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the deadline immediately for a bodyless response', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));

    const res = await fetchWithTimeout('http://example.com', {}, 5000);
    expect(res.status).toBe(204);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps branded Response accessors and instanceof working through the wrapper', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response('hi', { status: 201, statusText: 'Created', headers: { 'X-Trace': 'abc' } })
    )));

    const res = await fetchWithTimeout('http://example.com', {}, 5000);
    expect(res).toBeInstanceOf(Response);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(res.headers.get('x-trace')).toBe('abc');
    expect(await res.text()).toBe('hi');
  });

  it('does not lock the body when .body is only read as a truthiness check', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{"a":1}', { status: 200 }))));

    const res = await fetchWithTimeout('http://example.com', {}, 5000);
    expect(res.body).toBeTruthy();
    // The wrapper must not have drained/locked the real body just by being asked for.
    expect(await res.json()).toEqual({ a: 1 });
  });
it('rebuilds the body mirror after clone() tees the underlying stream', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('payload', { status: 500 }))));

    const res = await fetchWithTimeout('http://example.com', {}, 5000);
    expect(res.body).toBeTruthy();          // mirror built over the pre-clone stream
    const errorText = await res.clone().text();  // clone() swaps a fresh stream in behind .body
    expect(errorText).toBe('payload');

    // A cached mirror would still point at the stream cloning locked, and this
    // read would throw "ReadableStream is locked".
    const { value } = await res.body.getReader().read();
    expect(new TextDecoder().decode(value)).toBe('payload');
  });

  it('keeps the deadline armed when a consumer rejects while the stream is being read', async () => {
    const clearSpy = vi.spyOn(global, 'clearTimeout');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('payload', { status: 200 }))));

    const res = await fetchWithTimeout('http://example.com', {}, 5000);
    const reader = res.body.getReader();
    await reader.read();
    // The stream owns the body now, so this rejects — and must NOT retire the
    // deadline the live read still depends on.
    await expect(res.text()).rejects.toThrow();
    expect(clearSpy).not.toHaveBeenCalled();

    await reader.read();  // drain to done
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

