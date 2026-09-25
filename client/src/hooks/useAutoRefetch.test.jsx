import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAutoRefetch } from './useAutoRefetch';

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

const fireVisibilityChange = () => {
  document.dispatchEvent(new Event('visibilitychange'));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fetchFn whose every call stays pending until the test settles it, with a
// live count of overlapping calls.
const deferredFetch = () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const fn = vi.fn(() => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    let resolve;
    const promise = new Promise((r) => { resolve = r; }).finally(() => { active -= 1; });
    calls.push({ resolve });
    return promise;
  });
  return { fn, calls, maxActive: () => maxActive };
};

describe('useAutoRefetch', () => {
  beforeEach(() => {
    setVisibility('visible');
  });

  afterEach(() => {
    setVisibility('visible');
  });

  it('fetches immediately on mount and exposes data + loading', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useAutoRefetch(fetchFn, 10_000));

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ ok: true });
  });

  it('refetches on the configured interval', async () => {
    const fetchFn = vi.fn().mockResolvedValue('x');
    renderHook(() => useAutoRefetch(fetchFn, 30));
    await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('skips fetches while the tab is hidden and refires when visible', async () => {
    const fetchFn = vi.fn().mockResolvedValue('x');
    renderHook(() => useAutoRefetch(fetchFn, 20));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    setVisibility('hidden');
    await new Promise((r) => setTimeout(r, 80));
    const callsWhileHidden = fetchFn.mock.calls.length;
    expect(callsWhileHidden).toBe(1);

    setVisibility('visible');
    act(() => fireVisibilityChange());
    await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThan(callsWhileHidden));
  });

  it('skips entirely when enabled is false and starts/stops on toggle', async () => {
    const fetchFn = vi.fn().mockResolvedValue('x');
    const { rerender } = renderHook(
      ({ enabled }) => useAutoRefetch(fetchFn, 20, { enabled }),
      { initialProps: { enabled: false } },
    );

    await new Promise((r) => setTimeout(r, 80));
    expect(fetchFn).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    rerender({ enabled: false });
    const callsAfterDisable = fetchFn.mock.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(fetchFn).toHaveBeenCalledTimes(callsAfterDisable);
  });

  it('keeps prior data and clears loading when fetchFn throws', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce('first')
      .mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useAutoRefetch(fetchFn, 20));
    await waitFor(() => expect(result.current.data).toBe('first'));
    await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(result.current.data).toBe('first');
    expect(result.current.loading).toBe(false);
    warn.mockRestore();
  });

  it('exposes the failure as `error` alongside the preserved last-good `data`, and clears it on recovery', async () => {
    // `enabled: false` + manual refetch() calls give deterministic control
    // over each fetch, rather than racing an on-interval poll (refetch is
    // intentionally unconditional — see the hook's own doc comment).
    const fetchFn = vi.fn()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useAutoRefetch(fetchFn, 60_000, { enabled: false }));

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toBe('first');
    expect(result.current.error).toBeNull();

    await act(async () => { await result.current.refetch(); });
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.data).toBe('first'); // last-good data is untouched by the failure

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toBe('recovered');
    expect(result.current.error).toBeNull();
    warn.mockRestore();
  });

  it('survives non-Error rejections (null, string) without throwing inside the catch', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(null)
      .mockRejectedValueOnce('plain string')
      .mockResolvedValue('recovered');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useAutoRefetch(fetchFn, 20));
    await waitFor(() => expect(result.current.data).toBe('first'));
    await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(result.current.data).toBe('recovered');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips the on-mount fetch when immediate is false', async () => {
    const fetchFn = vi.fn().mockResolvedValue('x');
    renderHook(() => useAutoRefetch(fetchFn, 60, { immediate: false }));

    // Give the effect a chance to run; no fetch should fire yet.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).not.toHaveBeenCalled();

    // The interval still ticks after `intervalMs`.
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1), { timeout: 500 });
  });

  it('exposes a refetch handle that fetches on demand and updates data', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');
    const { result } = renderHook(() => useAutoRefetch(fetchFn, 60_000, { enabled: false }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.current.data).toBeNull();

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toBe('first');

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toBe('second');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not capture a stale fetchFn closure across renders', async () => {
    const first = vi.fn().mockResolvedValue('first');
    const second = vi.fn().mockResolvedValue('second');
    const { rerender } = renderHook(
      ({ fn }) => useAutoRefetch(fn, 20),
      { initialProps: { fn: first } },
    );
    await waitFor(() => expect(first).toHaveBeenCalledTimes(1));

    rerender({ fn: second });
    await waitFor(() => expect(second.mock.calls.length).toBeGreaterThanOrEqual(1));
  });

  it('preserves the previous data reference when compare returns true', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ updatedAt: 1, status: 'idle' })
      .mockResolvedValue({ updatedAt: 1, status: 'idle' });
    const compare = (prev, next) =>
      prev.updatedAt === next.updatedAt && prev.status === next.status;

    const { result } = renderHook(() => useAutoRefetch(fetchFn, 20, { compare }));

    await waitFor(() => expect(result.current.data).not.toBeNull());
    const first = result.current.data;

    await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(result.current.data).toBe(first);
  });

  it('replaces data when compare returns false', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ updatedAt: 1 })
      .mockResolvedValueOnce({ updatedAt: 2 });
    const compare = (prev, next) => prev.updatedAt === next.updatedAt;

    const { result } = renderHook(
      () => useAutoRefetch(fetchFn, 60_000, { enabled: false, compare }),
    );

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toEqual({ updatedAt: 1 });

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toEqual({ updatedAt: 2 });
  });

  it('always sets data on first fetch even with compare configured', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ updatedAt: 1 });
    const compare = vi.fn(() => true);

    const { result } = renderHook(() => useAutoRefetch(fetchFn, 60_000, { compare }));

    await waitFor(() => expect(result.current.data).toEqual({ updatedAt: 1 }));
    expect(compare).not.toHaveBeenCalled();
  });

  it('compare also applies to the manual refetch path', async () => {
    const snapshot = { updatedAt: 1 };
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ updatedAt: 1 });
    const compare = (prev, next) => prev.updatedAt === next.updatedAt;

    const { result } = renderHook(
      () => useAutoRefetch(fetchFn, 60_000, { enabled: false, compare }),
    );

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toBe(snapshot);

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toBe(snapshot);
  });

  describe('pollOnly mode', () => {
    it('returns { refetch } only — no data, no loading', async () => {
      const fetchFn = vi.fn().mockResolvedValue({ ignored: true });
      const { result } = renderHook(() => useAutoRefetch(fetchFn, 60_000, { pollOnly: true }));

      await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
      expect(result.current).toHaveProperty('refetch');
      expect(result.current).not.toHaveProperty('data');
      expect(result.current).not.toHaveProperty('loading');
    });

    it('still ticks on the interval', async () => {
      const fetchFn = vi.fn().mockResolvedValue(null);
      renderHook(() => useAutoRefetch(fetchFn, 30, { pollOnly: true }));
      await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3));
    });

    it('skips while hidden and refires on visibility', async () => {
      const fetchFn = vi.fn().mockResolvedValue(null);
      renderHook(() => useAutoRefetch(fetchFn, 20, { pollOnly: true }));
      await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

      setVisibility('hidden');
      await new Promise((r) => setTimeout(r, 80));
      const callsWhileHidden = fetchFn.mock.calls.length;
      expect(callsWhileHidden).toBe(1);

      setVisibility('visible');
      act(() => fireVisibilityChange());
      await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThan(callsWhileHidden));
    });

    it('respects enabled toggling', async () => {
      const fetchFn = vi.fn().mockResolvedValue(null);
      const { rerender } = renderHook(
        ({ enabled }) => useAutoRefetch(fetchFn, 20, { enabled, pollOnly: true }),
        { initialProps: { enabled: false } },
      );

      await new Promise((r) => setTimeout(r, 80));
      expect(fetchFn).not.toHaveBeenCalled();

      rerender({ enabled: true });
      await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    });

    it('exposes a working refetch that swallows errors via warn', async () => {
      const fetchFn = vi.fn()
        .mockResolvedValueOnce('first')
        .mockRejectedValueOnce(new Error('boom'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { result } = renderHook(
        () => useAutoRefetch(fetchFn, 60_000, { pollOnly: true, enabled: false }),
      );

      expect(fetchFn).not.toHaveBeenCalled();

      let returned;
      await act(async () => { returned = await result.current.refetch(); });
      expect(returned).toBe('first');

      await act(async () => { returned = await result.current.refetch(); });
      expect(returned).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not re-render on each tick (no data/loading state changes)', async () => {
      const fetchFn = vi.fn().mockResolvedValue(null);
      let renders = 0;
      const { rerender } = renderHook(() => {
        renders += 1;
        return useAutoRefetch(fetchFn, 20, { pollOnly: true });
      });

      await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3));
      const rendersAfterTicks = renders;
      // Pollster runs three+ times; should not re-render per tick.
      expect(rendersAfterTicks).toBeLessThanOrEqual(2);

      // Rerendering externally still works normally.
      rerender();
      expect(renders).toBe(rendersAfterTicks + 1);
    });
  });

  it('compare is bypassed when the new result is null, replacing prior data', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ updatedAt: 1 })
      .mockResolvedValueOnce(null);
    const compare = vi.fn(() => true);

    const { result } = renderHook(
      () => useAutoRefetch(fetchFn, 60_000, { enabled: false, compare }),
    );

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toEqual({ updatedAt: 1 });

    await act(async () => { await result.current.refetch(); });
    expect(result.current.data).toBeNull();
    expect(compare).not.toHaveBeenCalled();
  });

  describe('single-flight', () => {
    it('drops interval and visibility ticks while a fetch is pending', async () => {
      const { fn, calls } = deferredFetch();
      const { result } = renderHook(() => useAutoRefetch(fn, 15));
      expect(fn).toHaveBeenCalledTimes(1);

      await sleep(80); // several interval ticks
      act(() => fireVisibilityChange());
      expect(fn).toHaveBeenCalledTimes(1);

      await act(async () => { calls[0].resolve('first'); });
      expect(result.current.data).toBe('first');
      await waitFor(() => expect(fn).toHaveBeenCalledTimes(2)); // polling resumes
    });

    it('coalesces refetches during a pending fetch into one trailing fetch', async () => {
      const { fn, calls, maxActive } = deferredFetch();
      const { result } = renderHook(() => useAutoRefetch(fn, 60_000));
      expect(fn).toHaveBeenCalledTimes(1);

      let p1;
      let p2;
      act(() => {
        p1 = result.current.refetch();
        p2 = result.current.refetch();
      });
      expect(p2).toBe(p1);
      expect(fn).toHaveBeenCalledTimes(1);

      await act(async () => { calls[0].resolve('older'); });
      expect(fn).toHaveBeenCalledTimes(2);
      expect(result.current.data).toBe('older');

      await act(async () => { calls[1].resolve('newer'); });
      await expect(p1).resolves.toBe('newer');
      expect(result.current.data).toBe('newer');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(maxActive()).toBe(1);
    });

    it('serializes pollOnly fetches so side-effect writes land in request order', async () => {
      const { fn, calls, maxActive } = deferredFetch();
      const writes = [];
      const fetchFn = () => fn().then((v) => { writes.push(v); });
      const { result } = renderHook(() => useAutoRefetch(fetchFn, 10, { pollOnly: true }));

      act(() => { result.current.refetch(); });
      await sleep(50);
      expect(fn).toHaveBeenCalledTimes(1);

      await act(async () => { calls[0].resolve(1); });
      await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
      await act(async () => { calls[1].resolve(2); });
      expect(writes).toEqual([1, 2]);
      expect(maxActive()).toBe(1);
    });

    it('abandons a queued trailing refetch on unmount', async () => {
      const { fn, calls } = deferredFetch();
      const { result, unmount } = renderHook(() => useAutoRefetch(fn, 60_000));
      let trailing;
      act(() => { trailing = result.current.refetch(); });

      unmount();
      await expect(trailing).resolves.toBeUndefined();
      await act(async () => { calls[0].resolve('late'); });
      await sleep(20);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('keeps polling after a fetchFn that throws synchronously', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchFn = vi.fn()
        .mockImplementationOnce(() => { throw new Error('sync'); })
        .mockResolvedValue('ok');
      const { result } = renderHook(() => useAutoRefetch(fetchFn, 15));
      await waitFor(() => expect(result.current.data).toBe('ok'));
      warn.mockRestore();
    });

    it('applies the initial fetch under StrictMode remount', async () => {
      const { fn, calls } = deferredFetch();
      const { result } = renderHook(() => useAutoRefetch(fn, 60_000), { wrapper: StrictMode });
      expect(fn).toHaveBeenCalledTimes(1);

      await act(async () => { calls[0].resolve('first'); });
      expect(result.current.data).toBe('first');
      expect(result.current.loading).toBe(false);
    });

    it('drops a pending poll result once polling is disabled', async () => {
      const { fn, calls } = deferredFetch();
      const { result, rerender } = renderHook(
        ({ enabled }) => useAutoRefetch(fn, 60_000, { enabled }),
        { initialProps: { enabled: true } },
      );
      rerender({ enabled: false });

      await act(async () => { calls[0].resolve('stale'); });
      expect(result.current.data).toBeNull();
    });
  });
});
