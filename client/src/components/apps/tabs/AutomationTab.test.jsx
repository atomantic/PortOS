import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';

// ── Mock router — capture navigate calls, no real Router needed ────────────────
const mockNavigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({
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
}));
vi.mock('../../../services/api', () => api);

const AutomationTab = (await import('./AutomationTab')).default;

const SCHEDULE = {
  tasks: {
    'layered-intelligence': { type: 'daily', taskMetadata: {}, providerId: 'global-claude' },
    'app-improvement': { type: 'rotation', taskMetadata: {} },
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

describe('AutomationTab per-app overrides', () => {
  it('Configure toggle expands the provider override panel', async () => {
    await renderTab();
    const row = rowFor('layered-intelligence');
    const configureBtn = within(row).getByRole('button', { name: /show provider and model overrides/i });
    expect(configureBtn).toHaveAttribute('aria-expanded', 'false');
    // Provider selector is not rendered until expanded.
    expect(within(row).queryByLabelText('Provider override')).toBeNull();

    fireEvent.click(configureBtn);

    expect(configureBtn).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByLabelText('Provider override')).toBeInTheDocument();
  });

  it('changing the provider PATCHes updateAppTaskTypeOverride with providerId + cleared model', async () => {
    await renderTab();
    const row = rowFor('app-improvement');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model overrides/i }));

    const providerSelect = within(row).getByLabelText('Provider override');
    fireEvent.change(providerSelect, { target: { value: 'claude-cli' } });

    await waitFor(() => expect(api.updateAppTaskTypeOverride).toHaveBeenCalled());
    expect(api.updateAppTaskTypeOverride).toHaveBeenCalledWith(
      'app-1',
      'app-improvement',
      { providerId: 'claude-cli', model: '' },
      { silent: true }
    );
  });

  it('changing the model PATCHes updateAppTaskTypeOverride with the model', async () => {
    await renderTab({ 'app-improvement': { providerId: 'claude-cli' } });
    const row = rowFor('app-improvement');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model overrides/i }));

    fireEvent.change(within(row).getByLabelText('Model'), { target: { value: 'sonnet' } });

    await waitFor(() => expect(api.updateAppTaskTypeOverride).toHaveBeenCalledWith(
      'app-1',
      'app-improvement',
      { model: 'sonnet' },
      { silent: true }
    ));
  });

  it('excludes disabled providers from the picker', async () => {
    await renderTab();
    const row = rowFor('app-improvement');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model overrides/i }));
    const providerSelect = within(row).getByLabelText('Provider override');
    expect(within(providerSelect).queryByText('Disabled')).toBeNull();
    expect(within(providerSelect).getByText('Claude Code')).toBeInTheDocument();
  });

  it('layered-intelligence row shows a behavior link that deep-links to the Intelligence tab', async () => {
    await renderTab();
    const row = rowFor('layered-intelligence');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model overrides/i }));

    const link = within(row).getByRole('button', { name: /configure behavior/i });
    fireEvent.click(link);
    expect(mockNavigate).toHaveBeenCalledWith('/apps/app-1?edit=1&appTab=intelligence');
  });

  it('non-LI row does not show the behavior link', async () => {
    await renderTab();
    const row = rowFor('app-improvement');
    fireEvent.click(within(row).getByRole('button', { name: /show provider and model overrides/i }));
    expect(within(row).queryByRole('button', { name: /configure behavior/i })).toBeNull();
  });
});
