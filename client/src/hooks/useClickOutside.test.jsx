import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import useClickOutside from './useClickOutside';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// Mount an inside element attached to the ref and an outside sibling, so a
// mousedown on either lands inside vs outside the ref'd element.
function setupDom() {
  const inside = document.createElement('div');
  const outside = document.createElement('div');
  document.body.append(inside, outside);
  return { inside, outside };
}

describe('useClickOutside', () => {
  it('fires onOutside for a mousedown outside the ref, not inside it', () => {
    const { inside, outside } = setupDom();
    const onOutside = vi.fn();
    renderHook(() => {
      const ref = useRef(inside);
      useClickOutside(ref, true, onOutside);
    });
    fireEvent.mouseDown(inside);
    expect(onOutside).not.toHaveBeenCalled();
    fireEvent.mouseDown(outside);
    expect(onOutside).toHaveBeenCalledTimes(1);
  });

  it('does not bind while inactive', () => {
    const { outside } = setupDom();
    const onOutside = vi.fn();
    renderHook(() => {
      const ref = useRef(document.createElement('div'));
      useClickOutside(ref, false, onOutside);
    });
    fireEvent.mouseDown(outside);
    expect(onOutside).not.toHaveBeenCalled();
  });

  it('calls the latest onOutside without re-subscribing when the handler identity changes', () => {
    const { inside, outside } = setupDom();
    const first = vi.fn();
    const second = vi.fn();
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { rerender } = renderHook(
      ({ fn }) => {
        const ref = useRef(inside);
        useClickOutside(ref, true, fn);
      },
      { initialProps: { fn: first } },
    );
    const subs = addSpy.mock.calls.filter(([type]) => type === 'mousedown').length;
    rerender({ fn: second });
    fireEvent.mouseDown(outside);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls.filter(([type]) => type === 'mousedown').length).toBe(subs);
  });

  it('detaches the listener on unmount', () => {
    const { outside } = setupDom();
    const onOutside = vi.fn();
    const { unmount } = renderHook(() => {
      const ref = useRef(document.createElement('div'));
      useClickOutside(ref, true, onOutside);
    });
    unmount();
    fireEvent.mouseDown(outside);
    expect(onOutside).not.toHaveBeenCalled();
  });
});
