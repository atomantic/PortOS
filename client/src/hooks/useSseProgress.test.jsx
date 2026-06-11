import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSseProgress, isTerminalSseFrame } from './useSseProgress';
import { MockEventSource, lastEventSource as last } from '../test/mockEventSource';

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
});

afterEach(() => {
  delete global.EventSource;
});

describe('useSseProgress', () => {
  it('does not open a stream when url is null or enabled is false', () => {
    renderHook(() => useSseProgress(null));
    renderHook(() => useSseProgress('/x', { enabled: false }));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('accumulates frames and tracks the latest', () => {
    const { result } = renderHook(() => useSseProgress('/x'));
    act(() => {
      last().emit({ type: 'progress', progress: 0.25 });
      last().emit({ type: 'progress', progress: 0.5 });
    });
    expect(result.current.frames).toHaveLength(2);
    expect(result.current.latest).toEqual({ type: 'progress', progress: 0.5 });
    expect(result.current.closed).toBe(false);
  });

  it.each(['complete', 'canceled', 'cancelled', 'error'])(
    'closes the stream on a terminal %s frame',
    (type) => {
      const { result } = renderHook(() => useSseProgress('/x'));
      act(() => { last().emit({ type }); });
      expect(result.current.closed).toBe(true);
      expect(result.current.isOpen).toBe(false);
      expect(last().closed).toBe(true);
    },
  );

  it('marks the stream closed on a terminal connection failure', () => {
    const { result } = renderHook(() => useSseProgress('/x'));
    act(() => { last().fail(); });
    expect(result.current.closed).toBe(true);
    expect(result.current.latest).toBeNull();
  });

  it('resets state when the url changes', () => {
    const { result, rerender } = renderHook(({ url }) => useSseProgress(url), {
      initialProps: { url: '/a' },
    });
    act(() => { last().emit({ type: 'complete' }); });
    expect(result.current.closed).toBe(true);
    rerender({ url: '/b' });
    expect(result.current.closed).toBe(false);
    expect(result.current.frames).toHaveLength(0);
    expect(last().url).toBe('/b');
  });

  it('retains latest across a disable gap but resets closed — consumers must gate terminal handling on closed', () => {
    const { result, rerender } = renderHook(
      ({ url }) => useSseProgress(url, { enabled: !!url }),
      { initialProps: { url: '/a' } },
    );
    act(() => { last().emit({ type: 'error', error: 'boom' }); });
    expect(result.current.closed).toBe(true);
    // Stream disabled (consumer cleared its job id): closed resets, but the
    // terminal frame stays in `latest` — a consumer that re-enables and acts
    // on `latest` without checking `closed` would replay the stale terminal.
    rerender({ url: null });
    expect(result.current.closed).toBe(false);
    expect(result.current.latest).toEqual({ type: 'error', error: 'boom' });
  });

  it('isTerminalSseFrame matches the terminal set and rejects others', () => {
    expect(isTerminalSseFrame({ type: 'complete' })).toBe(true);
    expect(isTerminalSseFrame({ type: 'canceled' })).toBe(true);
    expect(isTerminalSseFrame({ type: 'cancelled' })).toBe(true);
    expect(isTerminalSseFrame({ type: 'error' })).toBe(true);
    expect(isTerminalSseFrame({ type: 'progress' })).toBe(false);
    expect(isTerminalSseFrame(null)).toBe(false);
  });
});
