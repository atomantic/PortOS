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
});
