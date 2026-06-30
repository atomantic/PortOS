import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import useEscapeKey from './useEscapeKey';

afterEach(() => vi.restoreAllMocks());

describe('useEscapeKey', () => {
  it('calls the handler on Escape while active', () => {
    const handler = vi.fn();
    renderHook(() => useEscapeKey(true, handler));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Escape keys', () => {
    const handler = vi.fn();
    renderHook(() => useEscapeKey(true, handler));
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not bind while inactive', () => {
    const handler = vi.fn();
    renderHook(() => useEscapeKey(false, handler));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls the latest handler without re-subscribing when the handler identity changes', () => {
    const first = vi.fn();
    const second = vi.fn();
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { rerender } = renderHook(({ fn }) => useEscapeKey(true, fn), {
      initialProps: { fn: first },
    });
    const subs = addSpy.mock.calls.filter(([type]) => type === 'keydown').length;
    // A new inline arrow every render (the common call-site shape) must not thrash the listener.
    rerender({ fn: second });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls.filter(([type]) => type === 'keydown').length).toBe(subs);
  });

  it('detaches the listener on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() => useEscapeKey(true, handler));
    unmount();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('detaches the listener when active flips to false', () => {
    const handler = vi.fn();
    const { rerender } = renderHook(({ active }) => useEscapeKey(active, handler), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(handler).not.toHaveBeenCalled();
  });
});
