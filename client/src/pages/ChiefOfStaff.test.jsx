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
  updateCosConfig: vi.fn(),
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

// #2654: the banner is now prop-driven, and paths that don't go through
// fetchData (socket-driven health checks / task changes) must still refresh the
// server-derived insight counts so the banner doesn't lag until the 30s poll.
describe('ChiefOfStaff insight freshness (#2654)', () => {
  const getSocketHandler = (event) => {
    const entry = socketStub.on.mock.calls.find(([evt]) => evt === event);
    return entry?.[1];
  };

  it('refreshes actionable insights when a socket health-check arrives', async () => {
    renderConfigTab();
    // The initial fetchData pulls insights once; wait for it before firing.
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const before = api.getCosActionableInsights.mock.calls.length;

    const handleHealthCheck = getSocketHandler('cos:health:check');
    expect(handleHealthCheck).toBeTypeOf('function');
    // Empty issues avoids the >0 branch's setTimeout(setSpeaking) so no state
    // update escapes act; refreshInsights fires unconditionally either way.
    await act(async () => {
      handleHealthCheck({ metrics: { timestamp: 1 }, issues: [] });
    });

    // Health doesn't call fetchData (that would clobber its status message) — it
    // re-pulls just insights, so the call count must advance past the initial.
    await waitFor(() =>
      expect(api.getCosActionableInsights.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it('refreshes actionable insights on a socket task change', async () => {
    renderConfigTab();
    await waitFor(() => expect(api.getCosActionableInsights).toHaveBeenCalled());
    const before = api.getCosActionableInsights.mock.calls.length;

    const handleTasksUserChanged = getSocketHandler('cos:tasks:user:changed');
    expect(handleTasksUserChanged).toBeTypeOf('function');
    await act(async () => {
      handleTasksUserChanged({ tasks: [], grouped: {} });
    });

    await waitFor(() =>
      expect(api.getCosActionableInsights.mock.calls.length).toBeGreaterThan(before),
    );
  });
});
