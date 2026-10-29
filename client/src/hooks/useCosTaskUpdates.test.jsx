import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const handlers = vi.hoisted(() => new Map());
vi.mock('../services/socket', () => ({ default: {
  on: (event, fn) => handlers.set(event, fn),
  off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
} }));
vi.mock('./useSocketSubscription', () => ({ useSocketSubscription: vi.fn() }));

const { useCosTaskUpdates } = await import('./useCosTaskUpdates');

describe('useCosTaskUpdates', () => {
  it('ignores partial preflight liveness patches while forwarding actual task transitions', () => {
    const onUpdate = vi.fn();
    const { unmount } = renderHook(() => useCosTaskUpdates(onUpdate));
    act(() => handlers.get('cos:tasks:changed')({ invalidated: true, task: { id: 'preflight-1', preflightActive: true } }));
    expect(onUpdate).not.toHaveBeenCalled();
    const task = { id: 'preflight-1', status: 'in_progress', preflightActive: true };
    act(() => handlers.get('cos:tasks:changed')({ task }));
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(task);
    unmount();
  });
});
