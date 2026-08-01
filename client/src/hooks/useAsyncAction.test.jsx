import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
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

  // There is no mounted guard on the trailing `setRunning(false)` (#3267): on
  // React 19 that setState is a silent no-op after unmount. Assert the
  // observable — resolving late must not throw and must still hand the caller
  // the fn's value — rather than the absence of a console warning React no
  // longer emits (an assertion that passed with the guard deleted).
  it('resolves to the fn value when the component unmounts mid-request', async () => {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const { result, unmount } = renderHook(() => useAsyncAction(async () => { await pending; return 'late'; }));

    // Kick off the action so `running` flips true and the await suspends.
    let runPromise;
    act(() => { runPromise = result.current[0](); });
    expect(result.current[1]).toBe(true);

    // Unmount while the action is still pending, then let it resolve.
    unmount();
    let resolved;
    await act(async () => {
      release();
      resolved = await runPromise;
    });

    expect(resolved).toBe('late');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  // The app runs under <React.StrictMode>, whose dev double-mount reuses the
  // hook's refs — a cleanup-only mounted guard is left false by the simulated
  // unmount, so `setRunning(false)` never fires and EVERY button backed by this
  // hook stays disabled after one click (#3264). This pins the fix.
  it('clears running under StrictMode so the action can be run again', async () => {
    const { result } = renderHook(() => useAsyncAction(async (x) => x * 2), {
      wrapper: StrictMode,
    });

    await act(async () => { await result.current[0](1); });
    expect(result.current[1]).toBe(false);

    // The second click is the one that broke: the button was still disabled.
    let second;
    await act(async () => { second = await result.current[0](21); });
    expect(second).toBe(42);
    expect(result.current[1]).toBe(false);
  });
});
