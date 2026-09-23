import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock the shared socket so the test can drive the `logs:*` handlers the hook
// registers and observe the subscribe/unsubscribe emits it sends. The hook now
// binds ONE listener per event at module load (shared across every consumer,
// per #8113's refcount registry), so `on` must support multiple registrations
// per event — unlike the earlier single-consumer version, `handlers` is never
// cleared between tests: the module-level listeners are bound exactly once
// for the whole file and must keep dispatching to every subsequent test.
const { handlers, emitted } = vi.hoisted(() => ({
  handlers: new Map(), // event -> Set<fn>
  emitted: [],
}));
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    off: (event, fn) => { handlers.get(event)?.delete(fn); },
    emit: (event, ...args) => { emitted.push([event, ...args]); },
  },
}));

import { useProcessLogs } from './useProcessLogs.js';

// Log lines are buffered and flushed on a 250ms debounce, so every assertion
// about `logs` must advance timers past the flush window first.
const FLUSH_MS = 250;
const flushLines = () => act(() => { vi.advanceTimersByTime(FLUSH_MS); });

/** Fire a socket frame on every registered listener and let the batch flush. */
const fire = (event, payload) => {
  act(() => { handlers.get(event)?.forEach(fn => fn(payload)); });
  flushLines();
};
/** Fire a frame WITHOUT flushing — for asserting the debounce itself. */
const fireRaw = (event, payload) => act(() => { handlers.get(event)?.forEach(fn => fn(payload)); });
const emitsOf = (event) => emitted.filter(([e]) => e === event).map(([, payload]) => payload);

describe('useProcessLogs', () => {
  beforeEach(() => { emitted.length = 0; vi.useFakeTimers(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('subscribes to the named process and reports lines', () => {
    const { result } = renderHook(() => useProcessLogs('game'));

    expect(emitsOf('logs:subscribe')).toEqual([{ processName: 'game', lines: 500 }]);
    expect(result.current.logs).toEqual([]);
    expect(result.current.subscribed).toBe(false);

    fire('logs:subscribed', { processName: 'game' });
    fire('logs:line', { processName: 'game', line: 'Compiling…', type: 'stdout', timestamp: 1 });

    expect(result.current.subscribed).toBe(true);
    expect(result.current.logs).toEqual([{ line: 'Compiling…', type: 'stdout', timestamp: 1 }]);
  });

  it('passes appId through so a custom PM2_HOME can be resolved server-side', () => {
    renderHook(() => useProcessLogs('game', { lines: 200, appId: 'app-1' }));
    expect(emitsOf('logs:subscribe')).toEqual([{ processName: 'game', lines: 200, appId: 'app-1' }]);
  });

  it('omits appId entirely when not supplied (default PM2_HOME)', () => {
    renderHook(() => useProcessLogs('game'));
    expect(emitsOf('logs:subscribe')[0]).not.toHaveProperty('appId');
  });

  it('ignores frames for a different process', () => {
    const { result } = renderHook(() => useProcessLogs('game'));
    fire('logs:subscribed', { processName: 'other' });
    fire('logs:line', { processName: 'other', line: 'not mine', type: 'stdout', timestamp: 1 });

    expect(result.current.subscribed).toBe(false);
    expect(result.current.logs).toEqual([]);
  });

  it('renders a stream error as a stderr line rather than throwing it away', () => {
    const { result } = renderHook(() => useProcessLogs('game'));
    fire('logs:error', { processName: 'game', error: 'pm2 unreachable' });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0]).toMatchObject({ line: 'Error: pm2 unreachable', type: 'stderr' });
  });

  it('does not subscribe when no process is named, and clears state', () => {
    const { result, rerender } = renderHook(({ name }) => useProcessLogs(name), {
      initialProps: { name: 'game' },
    });
    fire('logs:line', { processName: 'game', line: 'a', type: 'stdout', timestamp: 1 });
    expect(result.current.logs).toHaveLength(1);

    rerender({ name: null });

    expect(result.current.logs).toEqual([]);
    expect(result.current.subscribed).toBe(false);
    // Unsubscribed on the way out so the server tears the pm2 stream down.
    expect(emitsOf('logs:unsubscribe')).toEqual([{ processName: 'game' }]);
  });

  it('resets the buffer when switching processes so the old tail never bleeds through', () => {
    const { result, rerender } = renderHook(({ name }) => useProcessLogs(name), {
      initialProps: { name: 'game' },
    });
    fire('logs:subscribed', { processName: 'game' });
    fire('logs:line', { processName: 'game', line: 'old', type: 'stdout', timestamp: 1 });

    rerender({ name: 'server' });

    expect(result.current.logs).toEqual([]);
    expect(result.current.subscribed).toBe(false);
    expect(emitsOf('logs:subscribe')).toHaveLength(2);
  });

  it('clear() empties the buffer without unsubscribing', () => {
    const { result } = renderHook(() => useProcessLogs('game'));
    fire('logs:line', { processName: 'game', line: 'a', type: 'stdout', timestamp: 1 });

    act(() => { result.current.clear(); });
    expect(result.current.logs).toEqual([]);
    expect(emitsOf('logs:unsubscribe')).toEqual([]);

    // Still live — a new line lands after the clear.
    fire('logs:line', { processName: 'game', line: 'b', type: 'stdout', timestamp: 2 });
    expect(result.current.logs).toHaveLength(1);
  });

  it('caps the buffer so a chatty process cannot grow it without bound', () => {
    const { result } = renderHook(() => useProcessLogs('game'));
    act(() => {
      for (let i = 0; i < 1100; i++) {
        handlers.get('logs:line')?.forEach(fn => fn({ processName: 'game', line: `l${i}`, type: 'stdout', timestamp: i }));
      }
    });
    flushLines();

    expect(result.current.logs).toHaveLength(1000);
    // Oldest lines dropped, newest retained.
    expect(result.current.logs.at(-1).line).toBe('l1099');
    expect(result.current.logs[0].line).toBe('l100');
  });

  // The server emits one socket event PER LINE, which React does not auto-batch —
  // so a compiling desktop app would otherwise re-render per line.
  it('batches a burst of lines into a single state update', () => {
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useProcessLogs('game'); });
    const rendersAfterMount = renders;

    act(() => {
      for (let i = 0; i < 50; i++) {
        handlers.get('logs:line')?.forEach(fn => fn({ processName: 'game', line: `l${i}`, type: 'stdout', timestamp: i }));
      }
    });
    // Nothing applied yet — still inside the debounce window.
    expect(result.current.logs).toEqual([]);
    expect(renders).toBe(rendersAfterMount);

    flushLines();

    expect(result.current.logs).toHaveLength(50);
    // 50 lines cost one render, not 50.
    expect(renders - rendersAfterMount).toBe(1);
  });

  it('drops the pending batch when the process switches mid-window', () => {
    const { result, rerender } = renderHook(({ name }) => useProcessLogs(name), {
      initialProps: { name: 'game' },
    });
    // Buffered but not yet flushed when the switch happens.
    fireRaw('logs:line', { processName: 'game', line: 'old', type: 'stdout', timestamp: 1 });

    rerender({ name: 'server' });
    flushLines();

    // The old process's buffered tail must not land in the new one's buffer.
    expect(result.current.logs).toEqual([]);
  });

  it('clear() also drops lines buffered but not yet flushed', () => {
    const { result } = renderHook(() => useProcessLogs('game'));
    fireRaw('logs:line', { processName: 'game', line: 'a', type: 'stdout', timestamp: 1 });

    act(() => { result.current.clear(); });
    flushLines();

    // A pending timer must not repopulate the list the user just cleared.
    expect(result.current.logs).toEqual([]);
  });

  // --- Shared-stream registry (#8113) ---------------------------------

  it('two consumers of the same process share one subscribe, not two', () => {
    const first = renderHook(() => useProcessLogs('game'));
    const second = renderHook(() => useProcessLogs('game'));

    // Only the first consumer triggered a `logs:subscribe`.
    expect(emitsOf('logs:subscribe')).toHaveLength(1);

    fire('logs:line', { processName: 'game', line: 'shared', type: 'stdout', timestamp: 1 });
    expect(first.result.current.logs).toEqual([{ line: 'shared', type: 'stdout', timestamp: 1 }]);
    expect(second.result.current.logs).toEqual([{ line: 'shared', type: 'stdout', timestamp: 1 }]);

    first.unmount();
    second.unmount();
  });

  it('unmounting one of two consumers does not unsubscribe or freeze the survivor', () => {
    const first = renderHook(() => useProcessLogs('game'));
    const second = renderHook(() => useProcessLogs('game'));

    first.unmount();
    // The survivor is still attached — the server stream must stay alive.
    expect(emitsOf('logs:unsubscribe')).toEqual([]);

    fire('logs:line', { processName: 'game', line: 'still here', type: 'stdout', timestamp: 2 });
    expect(second.result.current.logs).toEqual([{ line: 'still here', type: 'stdout', timestamp: 2 }]);

    second.unmount();
    // Now the last consumer left — exactly one unsubscribe.
    expect(emitsOf('logs:unsubscribe')).toEqual([{ processName: 'game' }]);
  });

  it('a late-joining consumer is seeded from the existing tail without re-subscribing or duplicating the first consumer\'s tail', () => {
    const first = renderHook(() => useProcessLogs('game'));
    fire('logs:line', { processName: 'game', line: 'a', type: 'stdout', timestamp: 1 });
    fire('logs:line', { processName: 'game', line: 'b', type: 'stdout', timestamp: 2 });

    const second = renderHook(() => useProcessLogs('game'));

    // Still exactly one subscribe — the late joiner attached instead of
    // triggering a second `pm2 logs` spawn.
    expect(emitsOf('logs:subscribe')).toHaveLength(1);
    // Seeded with the tail seen so far, not an empty buffer.
    expect(second.result.current.logs).toEqual([
      { line: 'a', type: 'stdout', timestamp: 1 },
      { line: 'b', type: 'stdout', timestamp: 2 },
    ]);
    // The first consumer's own view is untouched by the late joiner — no
    // duplicated tail.
    expect(first.result.current.logs).toEqual([
      { line: 'a', type: 'stdout', timestamp: 1 },
      { line: 'b', type: 'stdout', timestamp: 2 },
    ]);

    first.unmount();
    second.unmount();
  });

  it('clear() on one consumer does not empty another consumer\'s lines', () => {
    const first = renderHook(() => useProcessLogs('game'));
    const second = renderHook(() => useProcessLogs('game'));
    fire('logs:line', { processName: 'game', line: 'a', type: 'stdout', timestamp: 1 });

    act(() => { first.result.current.clear(); });
    expect(first.result.current.logs).toEqual([]);
    expect(second.result.current.logs).toEqual([{ line: 'a', type: 'stdout', timestamp: 1 }]);

    first.unmount();
    second.unmount();
  });

  it('re-subscribes and resumes streaming after a reconnect', () => {
    const { result } = renderHook(() => useProcessLogs('game'));
    expect(emitsOf('logs:subscribe')).toHaveLength(1);

    // Server drops every stream owned by a disconnected socket
    // (cleanupSocketStreams) — a mounted consumer must re-subscribe on
    // 'connect' or it freezes with no error frame ever emitted.
    fireRaw('connect', undefined);
    expect(emitsOf('logs:subscribe')).toHaveLength(2);

    fire('logs:line', { processName: 'game', line: 'resumed', type: 'stdout', timestamp: 3 });
    expect(result.current.logs).toEqual([{ line: 'resumed', type: 'stdout', timestamp: 3 }]);
  });
});
