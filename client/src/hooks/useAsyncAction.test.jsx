import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAsyncAction } from './useAsyncAction';

const errorSpy = vi.fn();
vi.mock('../components/ui/Toast', () => ({
  default: { error: (...args) => errorSpy(...args) },
}));

describe('useAsyncAction', () => {
  beforeEach(() => {
    errorSpy.mockClear();
  });

  it('toggles running around a successful action and resolves to the fn value', async () => {
    const { result } = renderHook(() => useAsyncAction(async (x) => x * 2));

    expect(result.current[1]).toBe(false);

    let resolved;
    await act(async () => {
      resolved = await result.current[0](21);
    });

    expect(resolved).toBe(42);
    expect(result.current[1]).toBe(false);
  });

  it('toasts and resolves to null when the action throws', async () => {
    const { result } = renderHook(() =>
      useAsyncAction(async () => { throw new Error('boom'); }, { errorMessage: 'fallback' })
    );

    let resolved = 'unset';
    await act(async () => {
      resolved = await result.current[0]();
    });

    expect(resolved).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('boom');
    expect(result.current[1]).toBe(false);
  });

  it('falls back to errorMessage then a default when the error has no message', async () => {
    const { result } = renderHook(() => useAsyncAction(async () => { throw {}; }, { errorMessage: 'fallback' }));
    await act(async () => { await result.current[0](); });
    expect(errorSpy).toHaveBeenCalledWith('fallback');

    const { result: bare } = renderHook(() => useAsyncAction(async () => { throw {}; }));
    await act(async () => { await bare.current[0](); });
    expect(errorSpy).toHaveBeenCalledWith('Action failed');
  });

  it('does not call setRunning after the component unmounts mid-request', async () => {
    const setStateSpy = vi.spyOn(console, 'error');
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { result, unmount } = renderHook(() => useAsyncAction(async () => { await pending; return 'late'; }));

    // Kick off the action so `running` flips true and the await suspends.
    let runPromise;
    act(() => { runPromise = result.current[0](); });
    expect(result.current[1]).toBe(true);

    // Unmount while the action is still pending, then let it resolve.
    unmount();
    await act(async () => {
      release();
      await runPromise;
    });

    // React logs an "update on an unmounted component" error if the guard is
    // missing — the guard keeps that console.error from ever firing.
    const sawUnmountWarning = setStateSpy.mock.calls.some((call) =>
      String(call[0]).includes('unmounted')
    );
    expect(sawUnmountWarning).toBe(false);
    setStateSpy.mockRestore();
  });
});
