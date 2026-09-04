import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

// ── Mock router — capture navigate calls, no real Router needed ────────────────
const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// ── Mock toast ────────────────────────────────────────────────────────────────
const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: mockToast }));

// ── Mock API ──────────────────────────────────────────────────────────────────
const api = vi.hoisted(() => ({
  getAppTaskTypes: vi.fn(),
  getCosSchedule: vi.fn(),
  getCosStatus: vi.fn(),
  getProviders: vi.fn(),
  updateAppTaskTypeOverride: vi.fn(),
  toggleAllAppTaskTypes: vi.fn(),
  triggerCosOnDemandTask: vi.fn(),
  resumeCos: vi.fn(),
  // Consumed by the nested CustomTasksSection on mount.
  getCosJobs: vi.fn(),
  createCosJob: vi.fn(),
  updateCosJob: vi.fn(),
  toggleCosJob: vi.fn(),
  triggerCosJob: vi.fn(),
  deleteCosJob: vi.fn(),
  getSettings: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

const AutomationTab = (await import('./AutomationTab')).default;

const SCHEDULE = {
  tasks: {
    // Every row honors a per-app provider/model pin (#4783); the task's own pin
    // is what a row inherits when the app pins nothing.
    'layered-intelligence': { type: 'daily', taskMetadata: {}, providerId: 'global-claude' },
    'app-improvement': { type: 'rotation', taskMetadata: {} },
    security: { type: 'weekly', taskMetadata: { fileIssues: false }, fileIssuesCapable: true, defaultFileIssues: false },
  },
};

const PROVIDERS = {
  providers: [
    { id: 'claude-cli', name: 'Claude Code', type: 'cli', enabled: true, models: ['opus', 'sonnet'] },
    { id: 'global-claude', name: 'Global Claude', type: 'api', enabled: true, models: ['gpt-5.5'] },
    { id: 'disabled-one', name: 'Disabled', type: 'api', enabled: false, models: [] },
  ],
};

const renderTab = async (overrides = {}) => {
  api.getAppTaskTypes.mockResolvedValue({ taskTypeOverrides: overrides });
  api.getCosSchedule.mockResolvedValue(SCHEDULE);
  api.getCosStatus.mockResolvedValue({ paused: false });
  api.getProviders.mockResolvedValue(PROVIDERS);
  api.getCosJobs.mockResolvedValue({ jobs: [] });
  api.getSettings.mockResolvedValue({ timezone: 'UTC' });
  api.updateAppTaskTypeOverride.mockResolvedValue({ success: true });
  render(<AutomationTab appId="app-1" appName="MyApp" />);
  await screen.findByText('layered-intelligence');
  // Drain the remaining mount fetches (CustomTasksSection's getCosJobs etc.)
  // inside act — the schedule findByText above can win before they land.
  await act(async () => {});
};

// Find the task-row card that contains the given task-type label.
const rowFor = (taskType) => screen.getByText(taskType).closest('.bg-port-card');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AutomationTab per-app options', () => {
  it('Configure toggle expands the provider override panel', async () => {
    await renderTab();
    const row = rowFor('layered-intelligence');
    const configureBtn = within(row).getByRole('button', { name: /show provider and model options/i });
    expect(configureBtn).toHaveAttribute('aria-expanded', 'false');
    // Provider selector is not rendered until expanded.
    expect(within(row).queryByLabelText('Provider override')).toBeNull();

    fireEvent.click(configureBtn);

    expect(configureBtn).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByLabelText('Provider override')).toBeInTheDocument();
  });

  it('changing the provider PATCHes updateAppTaskTypeOverride with providerId + cleared model', async () => {
    await renderTab();
    const row = rowFor('layered-intelligence');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model options/i }));

    const providerSelect = within(row).getByLabelText('Provider override');
    fireEvent.change(providerSelect, { target: { value: 'claude-cli' } });

    await waitFor(() => expect(api.updateAppTaskTypeOverride).toHaveBeenCalled());
    expect(api.updateAppTaskTypeOverride).toHaveBeenCalledWith(
      'app-1',
      'layered-intelligence',
      { providerId: 'claude-cli', model: null },
      { silent: true }
    );
  });

  it('changing the model PATCHes updateAppTaskTypeOverride with the model', async () => {
    await renderTab({ 'layered-intelligence': { providerId: 'claude-cli' } });
    const row = rowFor('layered-intelligence');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model options/i }));

    fireEvent.change(within(row).getByLabelText('Model'), { target: { value: 'sonnet' } });

    await waitFor(() => expect(api.updateAppTaskTypeOverride).toHaveBeenCalledWith(
      'app-1',
      'layered-intelligence',
      { providerId: 'claude-cli', model: 'sonnet' },
      { silent: true }
    ));
  });

  it('excludes disabled providers from the picker', async () => {
    await renderTab();
    const row = rowFor('layered-intelligence');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model options/i }));
    const providerSelect = within(row).getByLabelText('Provider override');
    expect(within(providerSelect).queryByText('Disabled')).toBeNull();
    expect(within(providerSelect).getByText('Claude Code')).toBeInTheDocument();
  });

  it('layered-intelligence row shows a behavior link that deep-links to the Intelligence tab', async () => {
    await renderTab();
    const row = rowFor('layered-intelligence');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model options/i }));

    const link = within(row).getByRole('button', { name: /configure behavior/i });
    fireEvent.click(link);
    expect(mockNavigate).toHaveBeenCalledWith('/apps/app-1?edit=1&appTab=intelligence');
  });

  // The pin reaches the spawn for EVERY task type now (#4783), so the picker is
  // offered on every row rather than only where a buildTaskInput hook read it.
  it('offers the same provider picker on a task type with no hook', async () => {
    await renderTab();
    const row = rowFor('app-improvement');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model options/i }));
    expect(within(row).getByLabelText('Provider override')).toBeInTheDocument();
  });

  it('clearing the provider sends explicit nulls, matching the other pin surfaces', async () => {
    await renderTab({ 'app-improvement': { providerId: 'claude-cli', model: 'opus' } });
    const row = rowFor('app-improvement');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model options/i }));

    fireEvent.change(within(row).getByLabelText('Provider override'), { target: { value: '' } });
    await waitFor(() => expect(api.updateAppTaskTypeOverride).toHaveBeenCalledWith(
      'app-1',
      'app-improvement',
      { providerId: null, model: null },
      { silent: true }
    ));
  });

  it('Iss toggle PATCHes fileIssues on and forces the no-code posture', async () => {
    await renderTab();
    const row = rowFor('security');
    fireEvent.click(within(row).getByRole('button', { name: /File issues only/i }));
    await waitFor(() => expect(api.updateAppTaskTypeOverride).toHaveBeenCalledWith(
      'app-1',
      'security',
      { taskMetadata: { fileIssues: true, useWorktree: false, openPR: false, simplify: false } },
      { silent: true }
    ));
  });
});
