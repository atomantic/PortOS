import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { listeners, fetchStatus } = vi.hoisted(() => ({ listeners: new Map(), fetchStatus: vi.fn() }));
vi.mock('../services/apiSystem.js', () => ({ getMaintenanceStatus: fetchStatus }));
vi.mock('./useSocket.js', () => ({ useSocket: () => socket }));
const socket = { on: (name, fn) => listeners.set(name, fn), off: (name) => listeners.delete(name) };
import { useMaintenance } from './useMaintenance.js';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
afterEach(() => { cleanup(); fetchStatus.mockReset(); listeners.clear(); });
describe('confirmed maintenance readiness', () => {
  it('discards an older Ready response after a newer hold invalidation', async () => {
    const old = deferred(); const next = deferred();
    fetchStatus.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result } = renderHook(useMaintenance);
    act(() => { listeners.get('maintenance:changed')(); });
    await act(async () => next.resolve({ state: 'draining', blockers: [{ kind: 'mind-turn' }] }));
    await act(async () => old.resolve({ state: 'ready', blockers: [] }));
    expect(result.current.status.state).toBe('draining');
  });
  it('invalidates readiness on disconnect and requires a fresh reconnect read', async () => {
    fetchStatus.mockResolvedValueOnce({ state: 'ready' });
    const { result } = renderHook(useMaintenance);
    await act(async () => {});
    expect(result.current.status.state).toBe('ready');
    act(() => listeners.get('disconnect')());
    expect(result.current.status.state).toBe('unknown');
    fetchStatus.mockResolvedValueOnce({ state: 'draining' });
    await act(async () => listeners.get('connect')());
    expect(result.current.status.state).toBe('draining');
  });
  it('treats a failed read as unknown and cleans up all subscriptions', async () => {
    fetchStatus.mockRejectedValueOnce(new Error('offline'));
    const { result, unmount } = renderHook(useMaintenance);
    await act(async () => {});
    expect(result.current.status.state).toBe('unknown');
    unmount();
    expect(listeners.size).toBe(0);
  });
});
