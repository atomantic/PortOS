import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { coalesce } from './coalesce';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('coalesce', () => {
  it('runs once on the trailing edge for a burst of calls', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 100);
    c(); c(); c();
    expect(fn).not.toHaveBeenCalled(); // nothing fires synchronously
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes the LAST call\'s arguments through', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 100);
    c('a'); c('b'); c('c');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('fires again for a new burst after the window elapses', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 100);
    c();
    vi.advanceTimersByTime(100);
    c();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('each call within the window resets the timer (debounce semantics)', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 100);
    c();
    vi.advanceTimersByTime(80);
    c(); // resets — should not fire at the original 100ms mark
    vi.advanceTimersByTime(80);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cancel() prevents a pending flush from firing', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 100);
    c();
    expect(c.pending()).toBe(true);
    c.cancel();
    expect(c.pending()).toBe(false);
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel() is a no-op when nothing is pending', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 100);
    expect(() => c.cancel()).not.toThrow();
    expect(c.pending()).toBe(false);
  });

  it('defaults to a 100ms window', () => {
    const fn = vi.fn();
    const c = coalesce(fn);
    c();
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
