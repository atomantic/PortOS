import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInstallStream } from './useInstallStream';
import { MockEventSource, lastEventSource as last } from '../test/mockEventSource';

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
  // jsdom doesn't implement scrollIntoView; the auto-scroll effect calls it.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  delete global.EventSource;
  vi.useRealTimers();
});

describe('useInstallStream', () => {
  it('does not open a stream when disabled', () => {
    renderHook(() => useInstallStream('/x', { enabled: false }));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('does not open a stream when url is null', () => {
    renderHook(() => useInstallStream(null, { enabled: true }));
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('opens the given url when enabled and marks the stream started', () => {
    const { result } = renderHook(() => useInstallStream('/api/install', { enabled: true }));
    expect(last().url).toBe('/api/install');
    expect(result.current.streamStarted).toBe(true);
  });

  it('tracks stages and logs them', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true }));
    act(() => { last().emit({ type: 'stage', stage: 'venv', message: 'Creating venv' }); });
    expect(result.current.currentStage).toBe('venv');
    expect(result.current.logs).toEqual([{ kind: 'stage', text: 'Creating venv' }]);
  });

  it('falls back to the stage id when a stage frame has no message', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true }));
    act(() => { last().emit({ type: 'stage', stage: 'detect' }); });
    expect(result.current.logs).toEqual([{ kind: 'stage', text: 'detect' }]);
  });

  it('appends log frames as log lines', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true }));
    act(() => {
      last().emit({ type: 'log', message: 'line 1' });
      last().emit({ type: 'log', message: 'line 2' });
    });
    expect(result.current.logs).toEqual([
      { kind: 'log', text: 'line 1' },
      { kind: 'log', text: 'line 2' },
    ]);
  });

  it('sets done, logs success, fires onComplete and closes on complete', () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true, onComplete }));
    act(() => { last().emit({ type: 'complete', message: 'All set' }); });
    expect(result.current.done).toBe(true);
    expect(result.current.logs).toEqual([{ kind: 'success', text: 'All set' }]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(last().closed).toBe(true);
  });

  it('sets error, logs it and closes on error', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true }));
    act(() => { last().emit({ type: 'error', message: 'boom' }); });
    expect(result.current.error).toBe('boom');
    expect(result.current.logs).toEqual([{ kind: 'error', text: 'boom' }]);
    expect(last().closed).toBe(true);
  });

  it('surfaces a connection-lost error when the socket drops before complete', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true }));
    act(() => { last().fail(); });
    expect(result.current.error).toMatch(/Connection to installer lost/);
  });

  it('does NOT surface a connection-lost error when the socket drops after complete', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true }));
    act(() => { last().emit({ type: 'complete', message: 'done' }); });
    act(() => { last().fail(); });
    expect(result.current.error).toBeNull();
  });

  it('silently ignores unparseable frames', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true }));
    act(() => { expect(() => last().emitRaw('not json')).not.toThrow(); });
    expect(result.current.logs).toEqual([]);
    expect(last().closed).toBe(false);
  });

  it('caps the retained log lines at maxLogLines', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true, maxLogLines: 3 }));
    act(() => {
      for (let i = 0; i < 6; i++) last().emit({ type: 'log', message: `l${i}` });
    });
    expect(result.current.logs.map((e) => e.text)).toEqual(['l3', 'l4', 'l5']);
  });

  it('does not tear down the stream on parent re-render with a fresh onComplete', () => {
    let onComplete = vi.fn();
    const { rerender } = renderHook(({ cb }) => useInstallStream('/x', { enabled: true, onComplete: cb }), {
      initialProps: { cb: onComplete },
    });
    const first = last();
    onComplete = vi.fn();
    rerender({ cb: onComplete });
    // Same EventSource instance — no teardown/reopen from the new inline arrow.
    expect(MockEventSource.instances).toHaveLength(1);
    expect(first.closed).toBe(false);
    // The latest onComplete is the one that fires.
    act(() => { first.emit({ type: 'complete', message: 'done' }); });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('resets state and closes the stream when disabled', () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useInstallStream('/x', { enabled }),
      { initialProps: { enabled: true } },
    );
    const es = last();
    act(() => { result.current; es.emit({ type: 'log', message: 'hi' }); });
    rerender({ enabled: false });
    expect(es.closed).toBe(true);
    expect(result.current.logs).toEqual([]);
    expect(result.current.streamStarted).toBe(false);
    expect(result.current.done).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('ignores a stale callback from a superseded stream after url change', () => {
    const { result, rerender } = renderHook(
      ({ url }) => useInstallStream(url, { enabled: true }),
      { initialProps: { url: '/a' } },
    );
    const first = MockEventSource.instances[0];
    // url change re-runs the effect: cleanup closes `first`, a second stream opens.
    rerender({ url: '/b' });
    const second = MockEventSource.instances[1];
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);

    // A late frame on the now-superseded first stream must NOT mutate state
    // nor close the live second stream.
    act(() => { first.emit({ type: 'error', message: 'stale boom' }); });
    expect(result.current.error).toBeNull();
    expect(second.closed).toBe(false);

    // A stale onerror on the superseded stream is likewise ignored.
    act(() => { first.fail(); });
    expect(result.current.error).toBeNull();
    expect(second.closed).toBe(false);

    // The live stream still works.
    act(() => { second.emit({ type: 'log', message: 'live' }); });
    expect(result.current.logs.map((e) => e.text)).toEqual(['live']);
  });

  it('close() tears down the active stream', () => {
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true }));
    expect(last().closed).toBe(false);
    act(() => { result.current.close(); });
    expect(last().closed).toBe(true);
  });

  it('buffers log lines and flushes on the debounce window when flushMs > 0', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true, flushMs: 100 }));
    act(() => {
      last().emit({ type: 'log', message: 'a' });
      last().emit({ type: 'log', message: 'b' });
    });
    // Not flushed yet — still buffered.
    expect(result.current.logs).toEqual([]);
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.logs.map((e) => e.text)).toEqual(['a', 'b']);
  });

  it('drops a superseded stream\'s un-flushed buffer on url change (flushMs > 0)', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ url }) => useInstallStream(url, { enabled: true, flushMs: 100 }),
      { initialProps: { url: '/a' } },
    );
    const first = MockEventSource.instances[0];
    // Buffer a line on stream A but DON'T let the debounce fire.
    act(() => { first.emit({ type: 'log', message: 'stale-A' }); });
    expect(result.current.logs).toEqual([]);

    // url change re-runs the effect: cleanup cancels A's timer + drops its buffer.
    rerender({ url: '/b' });
    const second = MockEventSource.instances[1];
    act(() => { second.emit({ type: 'log', message: 'live-B' }); });
    act(() => { vi.advanceTimersByTime(100); });
    // Only B's line lands — A's buffered 'stale-A' must not leak in.
    expect(result.current.logs.map((e) => e.text)).toEqual(['live-B']);
  });

  it('flushes buffered lines immediately on a terminal frame even with flushMs > 0', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useInstallStream('/x', { enabled: true, flushMs: 100 }));
    act(() => {
      last().emit({ type: 'log', message: 'a' });
      last().emit({ type: 'complete', message: 'done' });
    });
    // complete forces a flush — both the buffered log and the success line land.
    expect(result.current.logs.map((e) => e.text)).toEqual(['a', 'done']);
    expect(result.current.done).toBe(true);
  });

  it('resets error/done/log state when the url changes while enabled (retry path)', () => {
    const { result, rerender } = renderHook(
      ({ url }) => useInstallStream(url, { enabled: true }),
      { initialProps: { url: '/install?attempt=1' } },
    );
    act(() => { last().emit({ type: 'error', message: 'pip exited with code 1' }); });
    expect(result.current.error).toBe('pip exited with code 1');
    expect(result.current.logs).toHaveLength(1);

    // A retry bumps the url (attempt counter) without toggling enabled — the
    // new stream must start clean or `error` wedges the consumer's
    // "installing" derivation and the old log lines leak into the new run.
    rerender({ url: '/install?attempt=2' });
    expect(result.current.error).toBeNull();
    expect(result.current.done).toBe(false);
    expect(result.current.logs).toEqual([]);
    expect(result.current.streamStarted).toBe(true);

    act(() => { last().emit({ type: 'complete', message: 'ok' }); });
    expect(result.current.done).toBe(true);
    expect(result.current.error).toBeNull();
  });
});
