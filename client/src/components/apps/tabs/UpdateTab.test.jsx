import { StrictMode } from 'react';
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
  // Flush pending passive effects FIRST. The component mirrors `updating` into
  // `updatingRef` via a separate effect (`useEffect(() => { updatingRef.current
  // = updating }, [updating])`), and handleDisconnect's guard reads that ref
  // synchronously. runUpdate() calls setUpdating(true) outside any act (after
  // awaiting the pre-update health check), so the "Reconciling..." button —
  // driven directly by the `updating` state — can commit to the DOM (and
  // satisfy the caller's waitFor) a scheduler tick before the ref-sync effect
  // runs. Without this flush the
  // ref can still be stale-false when we fire 'disconnect', the confirmation
  // timer never arms, and "Restarting..." never appears: the intermittent CI
  // failure (#2065). Draining effects here syncs the ref to the state
  // production always reaches over real network time.
  await act(async () => {});
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
    // The confirmation check must be silent — a real disconnect is the
    // primary case this fallback exists for, and a generic "Server
    // unreachable" toast firing right alongside the intended "restarting"
    // toast would be a confusing double-toast on the common path.
    expect(mockCheckHealth).toHaveBeenLastCalledWith({ silent: true });
  });

  it('does not pop an undismissable "restarting" toast if the component unmounts before the disconnect confirmation resolves', async () => {
    const { unmount } = render(<UpdateTab />);

    const button = await screen.findByRole('button', { name: 'Reconcile Now' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconciling...' })).toBeTruthy());

    // The server really did go down (confirms), but the user navigated away
    // before the 1.5s confirmation delay elapsed. Nothing is left mounted to
    // ever dismiss a toast.loading({ duration: Infinity }) popped after this.
    mockCheckHealth.mockResolvedValue(null);
    // Flush pending effects so updatingRef is true when we fire 'disconnect'
    // (see fireDisconnectAndConfirm) — otherwise the confirmation timer never
    // arms and this asserts "no toast" for the wrong reason.
    await act(async () => {});
    vi.useFakeTimers();
    handlers.get('disconnect')();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    vi.useRealTimers();

    expect(mockToast.loading).not.toHaveBeenCalled();
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

  it('still confirms a real disconnect under StrictMode (mountedRef survives the dev-mode phantom mount→cleanup→remount)', async () => {
    // React 18 StrictMode (on app-wide in main.jsx) double-invokes effects on
    // mount: mount → cleanup → remount. A mountedRef implemented as a bare
    // `useRef(true)` + cleanup-only effect never resets to `true` on the
    // remount, so it reads permanently `false` for the rest of the
    // component's real lifetime — silently killing the disconnect
    // confirmation fallback in dev mode from the very first render. Plain
    // `render()` doesn't reproduce this; wrap in StrictMode explicitly.
    render(<StrictMode><UpdateTab /></StrictMode>);

    const button = await screen.findByRole('button', { name: 'Reconcile Now' });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reconciling...' })).toBeTruthy());

    mockCheckHealth.mockResolvedValue(null);
    await fireDisconnectAndConfirm();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restarting...' })).toBeTruthy());
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

describe('UpdateTab — active CoS agent suppression', () => {
  beforeEach(() => {
    handlers.clear();
    mockCheckHealth.mockReset().mockResolvedValue({ version: '2.24.0', uptime: 120 });
    mockExecutePortosUpdate.mockReset();
    mockToast.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses the reconcile prompt and shows a paused notice while agents are live', async () => {
    mockGetUpdateStatus.mockReset().mockResolvedValue({
      ...OUT_OF_SYNC_STATUS,
      activeCosAgents: 2,
    });
    render(<UpdateTab />);

    // The paused notice appears in place of the reconcile action.
    await screen.findByText(/Update paused — CoS agents running/i);
    expect(screen.getByText(/2 CoS agents are currently running/i)).toBeTruthy();
    // The reconcile button must be gone — a restart would sever the agents.
    expect(screen.queryByRole('button', { name: 'Reconcile Now' })).toBeNull();
  });

  it('shows the reconcile button again once no agents are running', async () => {
    mockGetUpdateStatus.mockReset().mockResolvedValue({
      ...OUT_OF_SYNC_STATUS,
      activeCosAgents: 0,
    });
    render(<UpdateTab />);

    await screen.findByRole('button', { name: 'Reconcile Now' });
    expect(screen.queryByText(/Update paused/i)).toBeNull();
  });

  it('auto-clears the paused notice when the last agent finishes (4s status poll)', async () => {
    // Pins the notice's "this notice clears automatically" claim: while agents
    // are live the tab polls status every 4s (useAutoRefetch), so when the last
    // agent finishes the block lifts without the user re-checking.
    // Fake timers must be active BEFORE render so they own the poll interval the
    // effect schedules; and we drive re-renders with advanceTimersByTimeAsync
    // (flushes microtasks) instead of findBy/waitFor, which use real timers and
    // would hang against fake ones.
    let agentCount = 1;
    mockGetUpdateStatus.mockReset().mockImplementation(async () => ({
      ...OUT_OF_SYNC_STATUS,
      activeCosAgents: agentCount,
    }));
    vi.useFakeTimers();
    render(<UpdateTab />);

    // Flush the on-mount status fetch → blocked while the one agent runs.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/Update paused — CoS agents running/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reconcile Now' })).toBeNull();

    // The agent finishes; the next 4s poll observes activeCosAgents: 0.
    agentCount = 0;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    vi.useRealTimers();

    // Notice cleared, reconcile action restored — no manual re-check needed.
    expect(screen.queryByText(/Update paused/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Reconcile Now' })).toBeTruthy();
  });
});
