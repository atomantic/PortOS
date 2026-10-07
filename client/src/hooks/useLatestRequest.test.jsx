import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import useLatestRequest from './useLatestRequest.js';

describe('useLatestRequest', () => {
  it('only the most recently begun request is current', () => {
    const { result } = renderHook(() => useLatestRequest());
    const first = result.current();
    expect(first()).toBe(true);
    const second = result.current();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('invalidates an in-flight request on unmount', () => {
    const { result, unmount } = renderHook(() => useLatestRequest());
    const inFlight = result.current();
    unmount();
    expect(inFlight()).toBe(false);
  });
});
