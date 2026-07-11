import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock the socket module so the test can drive the `moltworld:*` handlers the
// hook registers with `on()`.
const handlers = new Map();
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
    emit: () => {},
  },
}));

// Mock the initial status fetch so mount doesn't hit the network.
vi.mock('../services/api', () => ({
  moltworldWsStatus: vi.fn(async () => ({ status: 'disconnected' })),
  moltworldWsConnect: vi.fn(async () => ({ status: 'connected' })),
  moltworldWsDisconnect: vi.fn(async () => ({ status: 'disconnected' })),
}));

const useMoltworldWs = (await import('./useMoltworldWs.js')).default;

const fire = (event, payload) => act(() => { handlers.get(event)?.(payload); });
// Drain the mount-effect status fetch (a pre-resolved mock promise) inside act
// so its setConnectionStatus can't land outside it after the test body.
const settle = () => act(async () => {});

describe('useMoltworldWs — presence empty-event transition (#2022)', () => {
  beforeEach(() => { handlers.clear(); });
  afterEach(cleanup);

  it('starts null (not-yet-known) before any presence event', async () => {
    const { result } = renderHook(() => useMoltworldWs());
    expect(result.current.presence).toBeNull();
    await settle();
  });

  it('clears the presence list when an empty presence event follows a populated one', async () => {
    const { result } = renderHook(() => useMoltworldWs());
    await settle();

    fire('moltworld:presence', { agents: [{ id: 'a1', name: 'Alice' }, { id: 'a2', name: 'Bob' }] });
    expect(result.current.presence).toHaveLength(2);

    fire('moltworld:presence', { agents: [] });
    expect(result.current.presence).toEqual([]);
  });

  it('clears the presence list on an empty nearby event too', async () => {
    const { result } = renderHook(() => useMoltworldWs());
    await settle();

    fire('moltworld:nearby', { nearby: [{ id: 'a1', name: 'Alice' }] });
    expect(result.current.presence).toHaveLength(1);

    fire('moltworld:nearby', { nearby: [] });
    expect(result.current.presence).toEqual([]);
  });

  it('ignores a malformed (non-array) presence payload, preserving prior state', async () => {
    const { result } = renderHook(() => useMoltworldWs());
    await settle();

    fire('moltworld:presence', { agents: [{ id: 'a1', name: 'Alice' }] });
    expect(result.current.presence).toHaveLength(1);

    // A well-formed empty array clears; a non-array payload must not.
    fire('moltworld:presence', { agents: 'oops' });
    expect(result.current.presence).toHaveLength(1);
  });

  it('ignores a payload missing both keys ({}), preserving prior state', async () => {
    const { result } = renderHook(() => useMoltworldWs());
    await settle();

    fire('moltworld:presence', { agents: [{ id: 'a1', name: 'Alice' }] });
    expect(result.current.presence).toHaveLength(1);

    // Absent/malformed (no agents AND no nearby) is not a confirmed-empty
    // snapshot — it must NOT clear the panel.
    fire('moltworld:presence', {});
    expect(result.current.presence).toHaveLength(1);
  });
});
