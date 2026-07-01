import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

// ── Mock socket — capture registered handlers so the test can fire 'disconnect' ──
const handlers = new Map();
vi.mock('../../../services/socket', () => ({
  default: {
    on: (event, fn) => { handlers.set(event, fn); },
    off: (event, fn) => { if (handlers.get(event) === fn) handlers.delete(event); },
  },
}));

// ── Mock toast ────────────────────────────────────────────────────────────────
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: mockToast }));

// ── Mock API ──────────────────────────────────────────────────────────────────
const mockGetUpdateStatus = vi.fn();
const mockCheckHealth = vi.fn();
const mockExecutePortosUpdate = vi.fn();
vi.mock('../../../services/api', () => ({
  getUpdateStatus: (...a) => mockGetUpdateStatus(...a),
  checkHealth: (...a) => mockCheckHealth(...a),
  executePortosUpdate: (...a) => mockExecutePortosUpdate(...a),
  checkForUpdate: vi.fn(),
  ignoreUpdateVersion: vi.fn(),
  clearIgnoredVersions: vi.fn(),
  syncPortosFork: vi.fn(),
}));

const UpdateTab = (await import('./UpdateTab')).default;

const OUT_OF_SYNC_STATUS = {
  currentVersion: '2.24.0',
  installState: { outOfSync: true, runningStaleCode: true },
};

// Fires 'disconnect' and advances past the 1.5s unreachability-confirmation
// delay in handleDisconnect, flushing the checkHealth() microtask through it.
const fireDisconnectAndConfirm = async () => {
  vi.useFakeTimers();
  handlers.get('disconnect')();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  vi.useRealTimers();
};

describe('UpdateTab reconcile flow', () => {
  beforeEach(() => {
    handlers.clear();
    mockGetUpdateStatus.mockReset().mockResolvedValue(OUT_OF_SYNC_STATUS);
    mockCheckHealth.mockReset().mockResolvedValue({ version: '2.24.0', uptime: 120 });
    mockExecutePortosUpdate.mockReset().mockResolvedValue({ tag: 'v2.24.0' });
    mockToast.mockClear();
    mockToast.loading.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms the restart-polling fallback once a disconnect is confirmed by an unreachable health check', async () => {
    render(<UpdateTab />);

    const button = await screen.findByRole('button', { name: 'Reconcile Now' });
    fireEvent.click(button);

    // runUpdate flips to "Reconciling..." once the update starts.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconciling...' })).toBeTruthy());
    expect(mockExecutePortosUpdate).toHaveBeenCalledWith({ reconcile: true });

    // The server process dies mid-update (pm2-stop kills it) before it ever
    // emits a 'restart' step or 'portos:update:complete' — only the socket
    // disconnecting tells the client the process is gone. Simulate the real
    // death: the health check that follows the disconnect also fails.
    expect(handlers.has('disconnect')).toBe(true);
    mockCheckHealth.mockResolvedValue(null);
    await fireDisconnectAndConfirm();

    // The fallback must arm from a confirmed 'disconnect' — the UI should not
    // stay stuck showing "Reconciling..." forever waiting for a step event
    // that will never arrive from the now-dead process.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restarting...' })).toBeTruthy());
  });

  it('ignores a disconnect caused by a transient network blip (server still reachable)', async () => {
    render(<UpdateTab />);

    const button = await screen.findByRole('button', { name: 'Reconcile Now' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconciling...' })).toBeTruthy());

    // PortOS is commonly used remotely over Tailscale — a socket 'disconnect'
    // can fire from a mobile network blip during the pre-pm2-stop steps, well
    // before the server actually dies. The health check right after the
    // disconnect still succeeds (server alive, same pre-update version), so
    // this must NOT be treated as proof of a restart.
    expect(handlers.has('disconnect')).toBe(true);
    await fireDisconnectAndConfirm();

    expect(screen.getByRole('button', { name: 'Reconciling...' })).toBeTruthy();
    expect(mockToast.loading).not.toHaveBeenCalled();
  });

  it('ignores a disconnect that happens while no update is in progress', async () => {
    render(<UpdateTab />);
    await screen.findByRole('button', { name: 'Reconcile Now' });

    expect(handlers.has('disconnect')).toBe(true);
    await fireDisconnectAndConfirm();

    // No update was running, so disconnect must not fake-arm the restart flow.
    expect(screen.getByRole('button', { name: 'Reconcile Now' })).toBeTruthy();
    expect(mockToast.loading).not.toHaveBeenCalled();
  });
});
