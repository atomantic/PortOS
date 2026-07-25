import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock the shared socket so the test can drive the `logs:*` handlers the hook
// registers and observe the subscribe/unsubscribe emits it sends.
const handlers = new Map();
const emitted = [];
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: (event, ...args) => { emitted.push([event, ...args]); },
  },
}));

import { useProcessLogs } from './useProcessLogs.js';

const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });
const emitsOf = (event) => emitted.filter(([e]) => e === event).map(([, payload]) => payload);

describe('useProcessLogs', () => {
  beforeEach(() => { handlers.clear(); emitted.length = 0; });
  afterEach(cleanup);

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
        handlers.get('logs:line')?.({ processName: 'game', line: `l${i}`, type: 'stdout', timestamp: i });
      }
    });

    expect(result.current.logs).toHaveLength(1000);
    // Oldest lines dropped, newest retained.
    expect(result.current.logs.at(-1).line).toBe('l1099');
    expect(result.current.logs[0].line).toBe('l100');
  });

  it('tears down its listeners on unmount', () => {
    const { unmount } = renderHook(() => useProcessLogs('game'));
    expect(handlers.has('logs:line')).toBe(true);

    unmount();

    expect(handlers.has('logs:line')).toBe(false);
    expect(handlers.has('logs:subscribed')).toBe(false);
    expect(handlers.has('logs:error')).toBe(false);
  });
});
