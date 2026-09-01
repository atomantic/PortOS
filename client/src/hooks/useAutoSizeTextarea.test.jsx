import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useAutoSizeTextarea from './useAutoSizeTextarea.js';

describe('useAutoSizeTextarea', () => {
  let mockResizeObserver;
  let observerCallback;
  let observedElement;

  beforeEach(() => {
    observedElement = null;
    mockResizeObserver = vi.fn(function(cb) {
      observerCallback = cb;
      this.observe = vi.fn((el) => { observedElement = el; });
      this.unobserve = vi.fn();
      this.disconnect = vi.fn();
    });
    vi.stubGlobal('ResizeObserver', mockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sets element height to scrollHeight on mount and when value changes', () => {
    const el = document.createElement('textarea');
    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(80);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      boxSizing: 'content-box',
    });

    const { rerender } = renderHook(
      ({ value }) => {
        const [ref] = useAutoSizeTextarea(value);
        ref(el);
        return ref;
      },
      { initialProps: { value: 'initial' } }
    );

    expect(el.style.height).toBe('80px');

    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(140);
    rerender({ value: 'updated with lots more text' });

    expect(el.style.height).toBe('140px');
  });

  it('includes vertical border offset when boxSizing is border-box', () => {
    const el = document.createElement('textarea');
    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(100);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      boxSizing: 'border-box',
      borderTopWidth: '2px',
      borderBottomWidth: '3px',
    });

    renderHook(() => {
      const [ref] = useAutoSizeTextarea('hello');
      ref(el);
    });

    expect(el.style.height).toBe('105px');
  });

  it('forwards the DOM node to an external ref object', () => {
    const el = document.createElement('textarea');
    const externalRef = { current: null };

    const { result } = renderHook(() => useAutoSizeTextarea('text', externalRef));
    const [ref] = result.current;
    act(() => { ref(el); });
    expect(externalRef.current).toBe(el);
    act(() => { ref(null); });
    expect(externalRef.current).toBeNull();
  });

  it('forwards the DOM node to an external callback ref', () => {
    const el = document.createElement('textarea');
    const callbackRef = vi.fn();

    renderHook(() => {
      const [ref] = useAutoSizeTextarea('text', callbackRef);
      ref(el);
    });

    expect(callbackRef).toHaveBeenCalledWith(el);
  });

  it('re-fits on width changes via ResizeObserver but ignores height-only changes', () => {
    const el = document.createElement('textarea');
    Object.defineProperty(el, 'clientWidth', { value: 300, writable: true, configurable: true });
    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(60);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ boxSizing: 'content-box' });

    renderHook(() => {
      const [ref] = useAutoSizeTextarea('test');
      ref(el);
    });

    expect(mockResizeObserver).toHaveBeenCalled();
    expect(observedElement).toBe(el);
    expect(el.style.height).toBe('60px');

    // Height changed on element, but width stayed same: should not re-trigger
    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(120);
    act(() => {
      observerCallback();
    });
    expect(el.style.height).toBe('60px');

    // Width changed (e.g. mobile viewport resize / word re-wrapping): triggers re-fit
    el.clientWidth = 200;
    act(() => {
      observerCallback();
    });
    expect(el.style.height).toBe('120px');
  });

  it('exposes the manual resize trigger function', () => {
    const el = document.createElement('textarea');
    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(50);
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ boxSizing: 'content-box' });

    let resizeFn;
    renderHook(() => {
      const [ref, resize] = useAutoSizeTextarea('manual');
      ref(el);
      resizeFn = resize;
    });

    expect(el.style.height).toBe('50px');
    vi.spyOn(el, 'scrollHeight', 'get').mockReturnValue(95);
    act(() => {
      resizeFn();
    });
    expect(el.style.height).toBe('95px');
  });
});
