import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSingleFlight } from './useSingleFlight';

describe('useSingleFlight', () => {
  it('drops a repeat while running, still prevents its submit, and runs again after a failure', async () => {
    let fail;
    const fn = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const { result } = renderHook(() => useSingleFlight(fn));
    const first = result.current();
    const repeat = { preventDefault: vi.fn() };
    await result.current(repeat);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(repeat.preventDefault).toHaveBeenCalledTimes(1);

    fail(new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    result.current();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps the guard across renders and lets different keys run together', () => {
    const fn = vi.fn(() => new Promise(() => {}));
    const { result, rerender } = renderHook(() => useSingleFlight(fn, (id) => id));
    result.current('a');
    rerender();
    result.current('a');
    result.current('b');
    expect(fn.mock.calls).toEqual([['a'], ['b']]);
  });
});
