import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimeTick, __resetTimeTickForTests } from './useTimeTick';
import { __resetVisibilityEventForTests } from './useVisibilityEvent';

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

const fireVisibilityChange = () => {
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useTimeTick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
    __resetVisibilityEventForTests();
    __resetTimeTickForTests();
  });

  afterEach(() => {
    __resetTimeTickForTests();
    __resetVisibilityEventForTests();
    setVisibility('visible');
    vi.useRealTimers();
  });

  it('returns the current Date.now() initially', () => {
    vi.setSystemTime(new Date('2026-05-21T12:00:00Z'));
    const { result } = renderHook(() => useTimeTick(60000));
    expect(result.current).toBe(Date.parse('2026-05-21T12:00:00Z'));
  });

  it('re-renders at the configured interval with a fresh now value', () => {
    vi.setSystemTime(new Date('2026-05-21T12:00:00Z'));
    const { result } = renderHook(() => useTimeTick(60000));
    const initial = result.current;

    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(result.current).toBeGreaterThan(initial);
    expect(result.current).toBe(initial + 60000);
  });

  it('subscribers at the same intervalMs share one underlying setInterval', () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');

    const a = renderHook(() => useTimeTick(60000));
    const b = renderHook(() => useTimeTick(60000));
    const c = renderHook(() => useTimeTick(60000));

    const calls60s = intervalSpy.mock.calls.filter(([, ms]) => ms === 60000);
    expect(calls60s).toHaveLength(1);

    a.unmount();
    b.unmount();
    c.unmount();

    intervalSpy.mockRestore();
  });

  it('subscribers at different intervalMs each get their own timer', () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');

    renderHook(() => useTimeTick(60000));
    renderHook(() => useTimeTick(1000));

    expect(intervalSpy.mock.calls.filter(([, ms]) => ms === 60000)).toHaveLength(1);
    expect(intervalSpy.mock.calls.filter(([, ms]) => ms === 1000)).toHaveLength(1);

    intervalSpy.mockRestore();
  });

  it('clears the underlying timer when the last subscriber unmounts', () => {
    const clearSpy = vi.spyOn(window, 'clearInterval');

    const a = renderHook(() => useTimeTick(60000));
    const b = renderHook(() => useTimeTick(60000));

    a.unmount();
    expect(clearSpy).not.toHaveBeenCalled();

    b.unmount();
    expect(clearSpy).toHaveBeenCalledTimes(1);

    clearSpy.mockRestore();
  });

  it('pauses the timer while the tab is hidden and resumes on visible', () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const clearSpy = vi.spyOn(window, 'clearInterval');

    renderHook(() => useTimeTick(60000));
    expect(intervalSpy.mock.calls.filter(([, ms]) => ms === 60000)).toHaveLength(1);

    setVisibility('hidden');
    act(() => fireVisibilityChange());
    expect(clearSpy).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    act(() => fireVisibilityChange());
    expect(intervalSpy.mock.calls.filter(([, ms]) => ms === 60000)).toHaveLength(2);

    intervalSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('fires once on tab-visible so deduped labels catch up immediately', () => {
    vi.setSystemTime(new Date('2026-05-21T12:00:00Z'));
    const { result } = renderHook(() => useTimeTick(60000));
    const initial = result.current;

    setVisibility('hidden');
    act(() => fireVisibilityChange());
    // Advance wall-clock while hidden — the timer is paused so result.current
    // should not advance from background ticks.
    vi.setSystemTime(new Date('2026-05-21T12:05:00Z'));

    setVisibility('visible');
    act(() => fireVisibilityChange());

    expect(result.current).toBeGreaterThan(initial);
    expect(result.current).toBe(Date.parse('2026-05-21T12:05:00Z'));
  });

  it('starts paused if the tab is already hidden at mount', () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    setVisibility('hidden');

    renderHook(() => useTimeTick(60000));

    expect(intervalSpy.mock.calls.filter(([, ms]) => ms === 60000)).toHaveLength(0);

    intervalSpy.mockRestore();
  });

  it('shares the document visibilitychange listener with useVisibilityEvent', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');

    // Mount useTimeTick first, then a useVisibilityEvent consumer.
    renderHook(() => useTimeTick(60000));
    // Lazy import the hook here so the singleton state isn't bridged in
    // the imports at the top of the test file.
    const { useVisibilityEvent } = await import('./useVisibilityEvent');
    renderHook(() => useVisibilityEvent(() => {}));

    const visListeners = addSpy.mock.calls.filter(([type]) => type === 'visibilitychange');
    expect(visListeners).toHaveLength(1);

    addSpy.mockRestore();
  });
});
