import { StrictMode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useSseJobSlot from './useSseJobSlot.js';
import { MockEventSource, lastEventSource } from '../test/mockEventSource';
import toast from '../components/ui/Toast';

vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
});
afterEach(() => vi.unstubAllGlobals());

// Direct starts in the same React turn uniquely exercise the synchronous guard;
// a rendered disabled button cannot cover a retained callback invoked twice.
it('reserves one slot synchronously and keeps default progress/terminal behavior across successive jobs', async () => {
  let resolveKickoff;
  const startRequest = vi.fn()
    .mockImplementationOnce(() => new Promise((resolve) => { resolveKickoff = resolve; }))
    .mockResolvedValueOnce({ jobId: 'second-job' });
  const onComplete = vi.fn();
  const { result } = renderHook(() => useSseJobSlot({
    startRequest, eventsUrl: (id) => `/events/${id}`, onComplete,
  }), { wrapper: StrictMode });
  act(() => {
    result.current.start('first-target');
    result.current.start('second-target');
  });
  expect(startRequest).toHaveBeenCalledTimes(1);
  expect(result.current).toMatchObject({ active: true, pending: true, context: 'first-target' });
  expect(MockEventSource.instances).toHaveLength(0);
  await act(async () => { resolveKickoff({ jobId: 'first-job' }); });
  expect(lastEventSource().url).toBe('/events/first-job');
  act(() => {
    result.current.start('second-target');
    lastEventSource().emit({ type: 'progress', percent: 42.4, stage: 'download' });
  });
  expect(startRequest).toHaveBeenCalledTimes(1);
  act(() => { lastEventSource().emit({ type: 'metadata' }); });
  expect(result.current).toMatchObject({ percent: 42, stage: 'download' });
  act(() => { lastEventSource().emit({ type: 'complete', filename: 'example.wav' }); });
  expect(onComplete).toHaveBeenCalledWith({ type: 'complete', filename: 'example.wav' }, 'first-target');
  expect(result.current.active).toBe(false);

  // Real useSseProgress retains its prior terminal frame across the idle gap.
  // Starting again must neither replay it nor immediately end the new slot.
  await act(async () => { result.current.start('second-target'); });
  expect(result.current).toMatchObject({ active: true, pending: false, context: 'second-target', percent: 0 });
  expect(lastEventSource().url).toBe('/events/second-job');
  expect(onComplete).toHaveBeenCalledTimes(1);
});

describe('unmounted kickoff ownership', () => {
  it.each(['resolve', 'reject'])('ignores a late %s and refuses starts through an unmounted callback', async (outcome) => {
    let resolveKickoff;
    let rejectKickoff;
    const startRequest = vi.fn(() => new Promise((resolve, reject) => {
      resolveKickoff = resolve;
      rejectKickoff = reject;
    }));
    const onKickoffSuccess = vi.fn();
    const onKickoffError = vi.fn();
    const { result, unmount } = renderHook(() => useSseJobSlot({
      startRequest, eventsUrl: (id) => `/events/${id}`, onKickoffSuccess, onKickoffError,
    }));
    const start = result.current.start;
    act(() => { start('example-target'); });
    unmount();
    await act(async () => {
      start('stale-target');
      if (outcome === 'resolve') resolveKickoff({ jobId: 'late-job' });
      else rejectKickoff(new Error('Late failure'));
    });
    expect(startRequest).toHaveBeenCalledTimes(1);
    expect(onKickoffSuccess).not.toHaveBeenCalled();
    expect(onKickoffError).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
