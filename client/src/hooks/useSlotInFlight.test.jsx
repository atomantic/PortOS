import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSlotInFlight from './useSlotInFlight';

describe('useSlotInFlight', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is not in flight for an empty / jobless slot', () => {
    expect(renderHook(() => useSlotInFlight(null)).result.current.inFlight).toBe(false);
    expect(renderHook(() => useSlotInFlight({})).result.current.inFlight).toBe(false);
    expect(renderHook(() => useSlotInFlight({ prompt: 'x' })).result.current.inFlight).toBe(false);
  });

  it('treats a slot that already has a filename as settled, even with a jobId present', () => {
    // The completed-render case: server leaves both jobId + filename on the
    // slot. Navigating back to it must NOT re-arm a disabled/loading flash.
    const slot = { jobId: 'job-1', filename: 'page0.png' };
    const { result } = renderHook(() => useSlotInFlight(slot));
    expect(result.current.inFlight).toBe(false);
    // No grace timer should be needed to clear it.
    act(() => { vi.advanceTimersByTime(6000); });
    expect(result.current.inFlight).toBe(false);
  });

  it('is in flight for a jobId-only slot until status resolves', () => {
    const slot = { jobId: 'job-2' };
    const { result } = renderHook(() => useSlotInFlight(slot));
    expect(result.current.inFlight).toBe(true);
    act(() => result.current.setStatus('completed'));
    expect(result.current.inFlight).toBe(false);
  });

  it('clears in flight via the 5s grace when status never resolves (archived job)', () => {
    const slot = { jobId: 'job-3' };
    const { result } = renderHook(() => useSlotInFlight(slot));
    expect(result.current.inFlight).toBe(true);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.inFlight).toBe(false);
  });

  it('stays in flight while a fetched status is non-terminal (queued/running)', () => {
    const slot = { jobId: 'job-4' };
    const { result } = renderHook(() => useSlotInFlight(slot));
    act(() => result.current.setStatus('queued'));
    expect(result.current.inFlight).toBe(true);
    // Grace only applies to an unresolved 'unknown' — a real queued status
    // keeps the button disabled until it actually finishes.
    act(() => { vi.advanceTimersByTime(6000); });
    expect(result.current.inFlight).toBe(true);
    act(() => result.current.setStatus('completed'));
    expect(result.current.inFlight).toBe(false);
  });

  it('re-arms in flight when the slot swaps to a fresh jobId with no filename', () => {
    // A re-render clears filename server-side and assigns a new jobId.
    const { result, rerender } = renderHook(({ slot }) => useSlotInFlight(slot), {
      initialProps: { slot: { jobId: 'job-5', filename: 'old.png' } },
    });
    expect(result.current.inFlight).toBe(false);
    act(() => rerender({ slot: { jobId: 'job-6' } }));
    expect(result.current.inFlight).toBe(true);
  });
});
