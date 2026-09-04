import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

// Capture the socket handlers so a test can fire the 'disconnect' a dying
// server produces, and inspect what the hook emitted.
const socketHandlers = new Map();
const emitted = [];
vi.mock('../services/socket', () => ({
  default: {
    on: (event, fn) => { socketHandlers.set(event, fn); },
    off: (event, fn) => { if (socketHandlers.get(event) === fn) socketHandlers.delete(event); },
    emit: (event, payload) => { emitted.push({ event, payload }); },
  },
}));
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), {
  success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({ default: mockToast }));
const mockCheckHealth = vi.fn();
vi.mock('../services/api', () => ({ checkHealth: (...a) => mockCheckHealth(...a) }));

import { useAppOperation } from './useAppOperation';
import { PORTOS_APP_ID } from '../lib/appIdentity';

// Fires 'disconnect' and advances past the unreachability-confirmation delay,
// flushing the checkHealth() microtask through it. The pending-effect flush
// first is what syncs the hook's `active` ref to the state a real dispatch
// would have reached over network time.
const disconnectAndConfirm = async () => {
  await act(async () => {});
  vi.useFakeTimers();
  socketHandlers.get('disconnect')();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  vi.useRealTimers();
};

describe('useAppOperation — PortOS self-update handoff', () => {
  beforeEach(() => {
    socketHandlers.clear();
    emitted.length = 0;
    vi.clearAllMocks();
    mockCheckHealth.mockResolvedValue({ version: '2.24.0', uptime: 120 });
  });

  afterEach(() => { vi.useRealTimers(); });

  it('records the running version before dispatching, without blocking the emit', () => {
    const { result } = renderHook(() => useAppOperation({ appId: PORTOS_APP_ID }));

    act(() => { result.current.startUpdate(PORTOS_APP_ID, 'PortOS'); });

    // Both in the same tick: the baseline probe must not sit between the click
    // and the dispatch, or every update pays a health round-trip of latency.
    expect(mockCheckHealth).toHaveBeenCalled();
    expect(emitted.some((e) => e.event === 'app:update' && e.payload.appId === PORTOS_APP_ID)).toBe(true);
  });

  it('reports `restarting` when the update takes the server down mid-run', async () => {
    // update.sh's `pm2 delete` kills the server — and this socket — during
    // pm2-stop, so `app:update:complete` never arrives and the operation stays
    // "in flight" forever. Every surface reading this hook would otherwise sit
    // on "Stopping PortOS apps..." indefinitely, even though the update
    // finishes fine in the background and the install comes back.
    const { result } = renderHook(() => useAppOperation({ appId: PORTOS_APP_ID }));
    act(() => { result.current.startUpdate(PORTOS_APP_ID, 'PortOS'); });
    expect(result.current.restarting).toBe(false);

    // A raw disconnect proves nothing on its own (PortOS is used remotely over
    // Tailscale) — the watch confirms the server is really unreachable first.
    mockCheckHealth.mockResolvedValue(null);
    await disconnectAndConfirm();

    await waitFor(() => expect(result.current.restarting).toBe(true));
    expect(mockToast.loading).toHaveBeenCalledWith(
      'PortOS is restarting...', expect.objectContaining({ id: 'portos-update-restart' }),
    );
  });

  it('ignores a blip that leaves the server reachable', async () => {
    const { result } = renderHook(() => useAppOperation({ appId: PORTOS_APP_ID }));
    act(() => { result.current.startUpdate(PORTOS_APP_ID, 'PortOS'); });

    // Health still answers — the socket dropped, the server did not.
    await disconnectAndConfirm();

    expect(result.current.restarting).toBe(false);
    expect(mockToast.loading).not.toHaveBeenCalled();
  });

  it('registers no restart listeners on a surface scoped to another app', async () => {
    // Another app's update never restarts PortOS, so that surface must neither
    // poll for a restart that is not coming nor hold dead handlers.
    renderHook(() => useAppOperation({ appId: 'example-managed-app' }));

    expect(socketHandlers.has('disconnect')).toBe(false);
    expect(socketHandlers.has('portos:update:step')).toBe(false);
  });

  it('ignores a PortOS restart frame on a surface scoped to another app', () => {
    // `app:update:step` is a BROADCAST, so a PortOS update running elsewhere
    // still reaches this surface's step handler. Arming off it would reload a
    // page that is watching an entirely different app's update.
    const { result } = renderHook(() => useAppOperation({ appId: 'example-managed-app' }));

    act(() => {
      socketHandlers.get('app:update:step')({
        appId: PORTOS_APP_ID, step: 'restart', status: 'running', message: 'Starting PortOS...',
      });
    });

    expect(result.current.restarting).toBe(false);
    expect(mockToast.loading).not.toHaveBeenCalled();
  });

  it('does not seed a baseline for a non-PortOS update', () => {
    const { result } = renderHook(() => useAppOperation({ appId: 'example-managed-app' }));

    act(() => { result.current.startUpdate('example-managed-app', 'Example App'); });

    expect(mockCheckHealth).not.toHaveBeenCalled();
  });
});
