import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFocusRefreshedList } from './useFocusRefreshedList.js';

const fireFocus = () => act(() => { window.dispatchEvent(new Event('focus')); });

describe('useFocusRefreshedList', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches once on mount and returns a name-sorted array', async () => {
    const fetchFn = vi.fn().mockResolvedValue([
      { id: '2', name: 'Zebra' },
      { id: '1', name: 'apple' },
    ]);
    const { result } = renderHook(() => useFocusRefreshedList(fetchFn));

    await waitFor(() => expect(result.current.length).toBe(2));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith({ silent: true });
    // Case-insensitive sort: 'apple' before 'Zebra'.
    expect(result.current.map((i) => i.id)).toEqual(['1', '2']);
  });

  it('preserves the previous array reference when the signature is unchanged', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce([{ id: '1', name: 'A' }])
      .mockResolvedValue([{ id: '1', name: 'A' }]);
    const { result } = renderHook(() => useFocusRefreshedList(fetchFn));

    await waitFor(() => expect(result.current.length).toBe(1));
    const first = result.current;

    // Advance past the 30s debounce so the focus handler actually refetches.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    fireFocus();
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    expect(result.current).toBe(first); // same id|name signature → no new array
  });

  it('replaces the array when the signature changes', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce([{ id: '1', name: 'A' }])
      .mockResolvedValue([{ id: '1', name: 'A renamed' }]);
    const { result } = renderHook(() => useFocusRefreshedList(fetchFn));

    await waitFor(() => expect(result.current[0].name).toBe('A'));

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    fireFocus();
    await waitFor(() => expect(result.current[0].name).toBe('A renamed'));
  });

  it('debounces focus refreshes within 30s of the last success', async () => {
    const fetchFn = vi.fn().mockResolvedValue([{ id: '1', name: 'A' }]);
    renderHook(() => useFocusRefreshedList(fetchFn));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    // Focus immediately — still inside the 30s window, so no refetch.
    fireFocus();
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('coerces a non-array result to an empty array and warns on rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useFocusRefreshedList(fetchFn, 'widgets'));
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(result.current).toEqual([]);

    const rejectFn = vi.fn().mockRejectedValue(new Error('boom'));
    renderHook(() => useFocusRefreshedList(rejectFn, 'widgets'));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls.some((c) => String(c[0]).includes('widgets'))).toBe(true);
    warn.mockRestore();
  });

  it('removes the focus listener on unmount', async () => {
    const fetchFn = vi.fn().mockResolvedValue([{ id: '1', name: 'A' }]);
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useFocusRefreshedList(fetchFn));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('focus', expect.any(Function));
    removeSpy.mockRestore();
  });
});
