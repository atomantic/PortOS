import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import useFirstTouchHint from './useFirstTouchHint.js';

afterEach(() => vi.useRealTimers());

describe('useFirstTouchHint', () => {
  it('shows a brief hint for the first touch only', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useFirstTouchHint({ durationMs: 100 }));

    act(() => result.current.showOnFirstTouch({ pointerType: 'touch' }));
    expect(result.current.visible).toBe(true);

    act(() => vi.advanceTimersByTime(100));
    expect(result.current.visible).toBe(false);

    act(() => result.current.showOnFirstTouch({ pointerType: 'touch' }));
    expect(result.current.visible).toBe(false);
  });

  it('does not show the touch guidance for mouse input', () => {
    const { result } = renderHook(() => useFirstTouchHint());

    act(() => result.current.showOnFirstTouch({ pointerType: 'mouse' }));

    expect(result.current.visible).toBe(false);
  });
});
