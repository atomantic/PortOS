import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import useAnchorReveal from './useAnchorReveal';

// A stub anchor element exposing just what the hook touches.
const makeEl = () => {
  const classes = new Set();
  return {
    scrollIntoView: vi.fn(),
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    has: (c) => classes.has(c),
  };
};

describe('useAnchorReveal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scrolls the target into view and flashes it, clearing the flash after the window', () => {
    const el = makeEl();
    renderHook(() => useAnchorReveal(() => el, 'c1'));
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(el.has('manuscript-anchor-flash')).toBe(true);
    vi.advanceTimersByTime(1300);
    expect(el.has('manuscript-anchor-flash')).toBe(false);
  });

  it('is a no-op when the key is falsy (nothing open)', () => {
    const el = makeEl();
    renderHook(() => useAnchorReveal(() => el, null));
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    expect(el.has('manuscript-anchor-flash')).toBe(false);
  });

  it('is a no-op when the target is absent (anchor not located)', () => {
    expect(() => renderHook(() => useAnchorReveal(() => null, 'c1'))).not.toThrow();
  });

  it('uses a custom reveal callback instead of scrollIntoView when provided', () => {
    const el = makeEl();
    const reveal = vi.fn();
    renderHook(() => useAnchorReveal(() => el, 'c1', { reveal }));
    expect(reveal).toHaveBeenCalledWith(el);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    expect(el.has('manuscript-anchor-flash')).toBe(true);
  });

  it('re-reveals when the key changes (prev/next step) but not on unrelated re-renders', () => {
    const el = makeEl();
    const { rerender } = renderHook(({ k }) => useAnchorReveal(() => el, k), {
      initialProps: { k: 'c1' },
    });
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    rerender({ k: 'c1' }); // same key — no refire
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    rerender({ k: 'c2' }); // stepped to next note — refire
    expect(el.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('clears the flash and pending timer on unmount', () => {
    const el = makeEl();
    const { unmount } = renderHook(() => useAnchorReveal(() => el, 'c1'));
    expect(el.has('manuscript-anchor-flash')).toBe(true);
    unmount();
    expect(el.has('manuscript-anchor-flash')).toBe(false);
  });
});
