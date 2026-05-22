import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAutoRefetch } from './useAutoRefetch';

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

const fireVisibilityChange = () => {
  document.dispatchEvent(new Event('visibilitychange'));
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
});
