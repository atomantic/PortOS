import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

describe('UpdateTab reconcile flow', () => {
  beforeEach(() => {
    handlers.clear();
    mockGetUpdateStatus.mockReset().mockResolvedValue(OUT_OF_SYNC_STATUS);
    mockCheckHealth.mockReset().mockResolvedValue({ version: '2.24.0', uptime: 120 });
    mockExecutePortosUpdate.mockReset().mockResolvedValue({ tag: 'v2.24.0' });
    mockToast.mockClear();
    mockToast.loading.mockClear();
  });

  it('arms the restart-polling fallback on socket disconnect, not just on the "restart" step', async () => {
    render(<UpdateTab />);

    const button = await screen.findByRole('button', { name: 'Reconcile Now' });
    fireEvent.click(button);

    // runUpdate flips to "Reconciling..." once the update starts.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconciling...' })).toBeTruthy());
    expect(mockExecutePortosUpdate).toHaveBeenCalledWith({ reconcile: true });

    // The server process dies mid-update (pm2-stop kills it) before it ever
    // emits a 'restart' step or 'portos:update:complete' — only the socket
    // disconnecting tells the client the process is gone.
    expect(handlers.has('disconnect')).toBe(true);
    fireEvent.click(button); // no-op safety: button should already reflect updating state
    handlers.get('disconnect')();

    // The fallback must arm from 'disconnect' alone — the UI should not stay
    // stuck showing "Reconciling..." forever waiting for a step event that
    // will never arrive from the now-dead process.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restarting...' })).toBeTruthy());
  });

  it('ignores a disconnect that happens while no update is in progress', async () => {
    render(<UpdateTab />);
    await screen.findByRole('button', { name: 'Reconcile Now' });

    expect(handlers.has('disconnect')).toBe(true);
    handlers.get('disconnect')();

    // No update was running, so disconnect must not fake-arm the restart flow.
    expect(screen.getByRole('button', { name: 'Reconcile Now' })).toBeTruthy();
    expect(mockToast.loading).not.toHaveBeenCalled();
  });
});
