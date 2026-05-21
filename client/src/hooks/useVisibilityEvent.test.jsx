import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisibilityEvent, __resetVisibilityEventForTests } from './useVisibilityEvent';

const setVisibility = (state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
};

const fireVisibilityChange = () => {
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('useVisibilityEvent', () => {
  let addSpy;
  let removeSpy;

  beforeEach(() => {
    setVisibility('visible');
    __resetVisibilityEventForTests();
    addSpy = vi.spyOn(document, 'addEventListener');
    removeSpy = vi.spyOn(document, 'removeEventListener');
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
    __resetVisibilityEventForTests();
    setVisibility('visible');
  });

  const visibilityListenerCount = (spy) =>
    spy.mock.calls.filter(([type]) => type === 'visibilitychange').length;

  it('attaches exactly one document listener regardless of subscriber count', () => {
    const a = renderHook(() => useVisibilityEvent(() => {}));
    const b = renderHook(() => useVisibilityEvent(() => {}));
    const c = renderHook(() => useVisibilityEvent(() => {}));

    expect(visibilityListenerCount(addSpy)).toBe(1);
    expect(visibilityListenerCount(removeSpy)).toBe(0);

    a.unmount();
    b.unmount();
    expect(visibilityListenerCount(removeSpy)).toBe(0);

    c.unmount();
    expect(visibilityListenerCount(removeSpy)).toBe(1);
  });

  it('fans out visibility changes to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => useVisibilityEvent(a));
    renderHook(() => useVisibilityEvent(b));

    setVisibility('hidden');
    act(() => fireVisibilityChange());
    expect(a).toHaveBeenLastCalledWith('hidden');
    expect(b).toHaveBeenLastCalledWith('hidden');

    setVisibility('visible');
    act(() => fireVisibilityChange());
    expect(a).toHaveBeenLastCalledWith('visible');
    expect(b).toHaveBeenLastCalledWith('visible');
  });

  it('calls the latest handler when the caller re-renders with a new function', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useVisibilityEvent(fn), { initialProps: { fn: first } });

    rerender({ fn: second });
    setVisibility('hidden');
    act(() => fireVisibilityChange());

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('hidden');
  });

  it('detaches when the last subscriber unmounts and re-attaches on the next mount', () => {
    const a = renderHook(() => useVisibilityEvent(() => {}));
    expect(visibilityListenerCount(addSpy)).toBe(1);

    a.unmount();
    expect(visibilityListenerCount(removeSpy)).toBe(1);

    renderHook(() => useVisibilityEvent(() => {}));
    expect(visibilityListenerCount(addSpy)).toBe(2);
  });
});
