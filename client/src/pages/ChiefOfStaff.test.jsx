import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Regression coverage for #2519 — the page-level Force Evaluate handler must
// only toast success after the request resolves, and must toast the error
// (not a success) when it rejects.
const api = vi.hoisted(() => ({
  getCosStatus: vi.fn(),
  getCosTasks: vi.fn(),
  getCosAgents: vi.fn(),
  getCosHealth: vi.fn(),
  getProviders: vi.fn(),
  getApps: vi.fn(),
  getCosLearningSummary: vi.fn(),
  getCosActionableInsights: vi.fn(),
  getCosBudgetUsage: vi.fn(),
  forceCosEvaluate: vi.fn(),
  forceHealthCheck: vi.fn(),
  updateCosConfig: vi.fn(),
  // HealthTab (rendered by the manual "Run Check" test) + its ProviderStatusCard.
  getCosTodayActivity: vi.fn(),
  getCosLearning: vi.fn(),
  getProviderStatuses: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const socketStub = vi.hoisted(() => ({ connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() }));

vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({ default: toast }));
vi.mock('../services/socket', () => ({ default: socketStub }));
// ConfigTab's provider/model hook fetches over the network — stub it.
vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [],
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    selectedProviderId: '',
    selectedModel: '',
  }),
}));

const ChiefOfStaff = (await import('./ChiefOfStaff')).default;

const config = {
  avatarStyle: 'svg',
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxProcessMemoryMb: 2048,
  autoStart: false,
  improvementEnabled: true,
  proactiveMode: true,
  idleReviewEnabled: true,
  immediateExecution: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosStatus.mockResolvedValue({ running: false, config, stats: {} });
  api.getCosTasks.mockResolvedValue({ user: null, cos: null });
  api.getCosAgents.mockResolvedValue([]);
  api.getCosHealth.mockResolvedValue(null);
  api.getProviders.mockResolvedValue({ providers: [] });
  api.getApps.mockResolvedValue([]);
  api.getCosLearningSummary.mockResolvedValue(null);
  api.getCosActionableInsights.mockResolvedValue({ insights: [] });
  api.forceHealthCheck.mockResolvedValue({ metrics: { timestamp: 1 }, issues: [] });
  api.getCosTodayActivity.mockResolvedValue({ isRunning: false, stats: { completed: 0 } });
  api.getCosLearning.mockResolvedValue(null);
  api.getProviderStatuses.mockResolvedValue({ providers: {} });
  api.getCosBudgetUsage.mockResolvedValue({ usage: {} });
});

const renderConfigTab = () => render(
  <MemoryRouter initialEntries={['/cos/config']}>
    <Routes>
      <Route path="/cos/:tab" element={<ChiefOfStaff />} />
    </Routes>
  </MemoryRouter>,
);

describe('ChiefOfStaff handleForceEvaluate', () => {
  it('does not toast success or advance the status message when the evaluate fails', async () => {
    api.forceCosEvaluate.mockRejectedValue(new Error('evaluate failed'));
    renderConfigTab();

    const button = await screen.findByRole('button', { name: /Force Evaluate/i });
    fireEvent.click(button);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('evaluate failed'));
    expect(toast.success).not.toHaveBeenCalled();
    // State contract: a failed evaluate must NOT switch the status bubble to the
    // "Evaluating tasks..." (thinking) message — it stays on the idle message.
    expect(screen.queryAllByText('Evaluating tasks...')).toHaveLength(0);
    expect(screen.queryAllByText('Idle - waiting for tasks...').length).toBeGreaterThan(0);
  });

  it('toasts success and advances the status message after the evaluate resolves', async () => {
    api.forceCosEvaluate.mockResolvedValue({ success: true });
    renderConfigTab();

    const button = await screen.findByRole('button', { name: /Force Evaluate/i });
    fireEvent.click(button);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evaluation triggered'));
    expect(toast.error).not.toHaveBeenCalled();
    // State contract: success advances the status bubble to the evaluating message.
    await waitFor(() => expect(screen.queryAllByText('Evaluating tasks...').length).toBeGreaterThan(0));
    // Must pass { silent: true } so the custom catch is the only error toast.
    expect(api.forceCosEvaluate).toHaveBeenCalledWith({ silent: true });
  });
});

// #2654: the banner is now prop-driven, refreshed only through fetchData. There
// is deliberately no on-demand insights refresh: /cos/actionable-insights runs a
// health check that AUTO-RESTARTS errored processes and re-emits cos:health:check,
// so an on-demand refresh would either loop (from the socket handler) or fire a
// second process-restart (from the manual "Run Check" button). These guards pin
// that neither the socket handler nor the manual button re-fetches insights, plus
// the lastCheck guard that stops a stale fetchData read clobbering fresher health.
describe('ChiefOfStaff insight freshness (#2654)', () => {
  const getSocketHandler = (event) => {
    const entry = socketStub.on.mock.calls.find(([evt]) => evt === event);
    return entry?.[1];
  };

  const renderAt = (tab) => render(
    <MemoryRouter initialEntries={[`/cos/${tab}`]}>
      <Routes>
        <Route path="/cos/:tab" element={<ChiefOfStaff />} />
      </Routes>
    </MemoryRouter>,
  );

  it('does NOT re-fetch insights on a socket health-check (no feedback loop)', async () => {
    renderConfigTab();
    // The initial fetchData pulls insights once; wait for it before firing.
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const before = api.getCosActionableInsights.mock.calls.length;

    const handleHealthCheck = getSocketHandler('cos:health:check');
    expect(handleHealthCheck).toBeTypeOf('function');
    // Empty issues avoids the >0 branch's setTimeout(setSpeaking) so no state
    // update escapes act.
    await act(async () => {
      handleHealthCheck({ metrics: { timestamp: 1 }, issues: [] });
    });
    // Give any (buggy) async refresh a tick to fire before asserting it didn't.
    await act(async () => { await Promise.resolve(); });

    // A socket-driven re-fetch here would loop against the health-checking
    // endpoint — the count must stay put; the poll refreshes the banner instead.
    expect(api.getCosActionableInsights.mock.calls.length).toBe(before);
  });

  it('does NOT re-fetch insights on the manual "Run Check" button (no second process-restart)', async () => {
    renderAt('health');
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const before = api.getCosActionableInsights.mock.calls.length;

    const button = await screen.findByRole('button', { name: /Run Check/i });
    fireEvent.click(button);

    // The button runs its own health check via forceHealthCheck and shows the
    // result — but must NOT also hit the insights endpoint, which would run a
    // second process-restarting health check ~1s later. Banner refreshes on poll.
    await waitFor(() => expect(api.forceHealthCheck).toHaveBeenCalledWith({ silent: true }));
    await act(async () => { await Promise.resolve(); });
    expect(api.getCosActionableInsights.mock.calls.length).toBe(before);
  });

  it('does not let a stale fetchData health read clobber a fresher one', async () => {
    // The insights call inside fetchData triggers a fresh server health check
    // whose socket emit can update `health` before fetchData's own getCosHealth
    // read (which sees the pre-check state) resolves. fetchData must keep the
    // newer health by lastCheck instead of overwriting it with the stale read.
    api.getCosHealth.mockResolvedValue({
      lastCheck: '2026-01-01T00:00:02Z',
      issues: [{ type: 'error', category: 'memory', message: 'FRESH_ISSUE' }],
    });
    renderAt('health');
    // Initial fetchData paints the fresh issue.
    expect(await screen.findByText('FRESH_ISSUE')).toBeInTheDocument();

    // Next fetchData (apps:changed) reads a STALE, older, issue-free health.
    api.getCosHealth.mockResolvedValue({ lastCheck: '2026-01-01T00:00:01Z', issues: [] });
    const handleAppsChanged = getSocketHandler('apps:changed');
    expect(handleAppsChanged).toBeTypeOf('function');
    await act(async () => {
      handleAppsChanged();
      await Promise.resolve();
    });

    // The guard keeps the fresher health — the issue must NOT disappear.
    await waitFor(() => expect(api.getApps.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText('FRESH_ISSUE')).toBeInTheDocument();
    expect(screen.queryByText('All Systems Healthy')).not.toBeInTheDocument();
  });

  it('does not let a timestamp-less health read clobber a fresher timestamped one', async () => {
    api.getCosHealth.mockResolvedValue({
      lastCheck: '2026-01-01T00:00:02Z',
      issues: [{ type: 'error', category: 'memory', message: 'FRESH_ISSUE' }],
    });
    renderAt('health');
    expect(await screen.findByText('FRESH_ISSUE')).toBeInTheDocument();

    // A read with no (parseable) lastCheck must not overwrite the timestamped,
    // fresher health — Date.parse('') is NaN, which must NOT win the guard.
    api.getCosHealth.mockResolvedValue({ issues: [] });
    const handleAppsChanged = getSocketHandler('apps:changed');
    await act(async () => {
      handleAppsChanged();
      await Promise.resolve();
    });

    await waitFor(() => expect(api.getApps.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText('FRESH_ISSUE')).toBeInTheDocument();
    expect(screen.queryByText('All Systems Healthy')).not.toBeInTheDocument();
  });

  it('preserves last-good health when a fetchData health read fails (null)', async () => {
    api.getCosHealth.mockResolvedValue({
      lastCheck: '2026-01-01T00:00:02Z',
      issues: [{ type: 'error', category: 'memory', message: 'FRESH_ISSUE' }],
    });
    renderAt('health');
    expect(await screen.findByText('FRESH_ISSUE')).toBeInTheDocument();

    // A failed health read (rejects → .catch → null) must not blank the banner.
    api.getCosHealth.mockRejectedValue(new Error('boom'));
    const handleAppsChanged = getSocketHandler('apps:changed');
    await act(async () => {
      handleAppsChanged();
      await Promise.resolve();
    });

    await waitFor(() => expect(api.getApps.mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText('FRESH_ISSUE')).toBeInTheDocument();
    expect(screen.queryByText('All Systems Healthy')).not.toBeInTheDocument();
  });
});
