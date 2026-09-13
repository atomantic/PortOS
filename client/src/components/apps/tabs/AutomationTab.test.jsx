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
  it('acknowledges a slow run immediately, prevents duplicate clicks, and retains the queued receipt', async () => {
    await renderTab({ security: { enabled: true } });
    let resolveRun;
    api.triggerCosOnDemandTask.mockReturnValueOnce(new Promise(resolve => { resolveRun = resolve; }));
    mockToast.loading.mockReturnValueOnce('run-toast');
    const row = rowFor('security');
    fireEvent.click(within(row).getByRole('button', { name: 'Run Now' }));
    expect(mockToast.loading).toHaveBeenCalledWith('Sending security request for MyApp…');
    const sending = within(row).getByRole('button', { name: 'Sending…' });
    expect(sending).toBeDisabled();
    fireEvent.click(sending);
    expect(api.triggerCosOnDemandTask).toHaveBeenCalledTimes(1);
    expect(mockToast.success).not.toHaveBeenCalled();
    await act(async () => resolveRun({ success: true, request: { id: 'request-1' } }));
    expect(mockToast.dismiss).toHaveBeenCalledWith('run-toast');
    expect(mockToast.success).toHaveBeenCalledWith(expect.stringContaining('Queued security request for MyApp'));
    expect(within(row).getByText('Request queued')).toBeVisible();
    expect(within(row).getByRole('button', { name: 'Run Now' })).toBeEnabled();
  });

  it('clears sending feedback on rejection without claiming the run was queued', async () => {
    await renderTab({ security: { enabled: true } });
    api.triggerCosOnDemandTask.mockRejectedValueOnce(new Error('CoS unavailable'));
    mockToast.loading.mockReturnValueOnce('failed-run-toast');
    const row = rowFor('security');
    fireEvent.click(within(row).getByRole('button', { name: 'Run Now' }));
    await waitFor(() => expect(mockToast.dismiss).toHaveBeenCalledWith('failed-run-toast'));
    expect(mockToast.error).toHaveBeenCalledWith('CoS unavailable');
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(within(row).queryByText('Request queued')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Run Now' })).toBeEnabled();
  });

  it('puts custom automations before the shared schedule cards and shows app cadence', async () => {
    await renderTab({ security: { enabled: true, interval: 'on-demand' } });
    const custom = screen.getByText('Custom Tasks');
    const scheduled = screen.getByText('Scheduled Task Options');
    expect(custom.compareDocumentPosition(scheduled) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = rowFor('security');
    expect(within(row).getByRole('button', { name: 'Run Now' })).toBeEnabled();
    expect(within(row).queryByText('Never run')).toBeNull();
    expect(within(row).queryByText('App coverage')).toBeNull();
    expect(within(row).getByText('on-demand')).toBeInTheDocument();
  });

  it('saves the selected app toggle before permitting a run and preserves state on failure', async () => {
    await renderTab();
    const row = rowFor('security');
    let rejectSave;
    api.updateAppTaskTypeOverride.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSave = reject; }));
    fireEvent.click(within(row).getByRole('switch', { name: 'security enabled for this app: off' }));
    expect(api.updateAppTaskTypeOverride).toHaveBeenCalledWith('app-1', 'security', { enabled: true }, { silent: true });
    expect(within(row).getByRole('button', { name: 'Run Now' })).toBeDisabled();
    await act(async () => rejectSave(new Error('Save failed')));
    expect(within(row).getByRole('switch', { name: 'security enabled for this app: off' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(row).getByRole('switch', { name: 'security enabled for this app: off' }));
    api.updateAppTaskTypeOverride.mockResolvedValue({ success: true });
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Run Now' })).toBeEnabled());
    api.triggerCosOnDemandTask.mockResolvedValue({ success: true });
    fireEvent.click(within(row).getByRole('button', { name: 'Run Now' }));
    await waitFor(() => expect(api.triggerCosOnDemandTask).toHaveBeenCalledWith('security', 'app-1', { silent: true }));
  });

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

  it('flags a provider override that diverges from the schedule pin, collapsed', async () => {
    // Schedule pins layered-intelligence to 'global-claude'; the app overrides
    // it to a DIFFERENT provider — the exact silent-shadowing scenario #4783
    // documents. Must be visible without expanding Configure.
    await renderTab({ 'layered-intelligence': { providerId: 'claude-cli' } });
    const row = rowFor('layered-intelligence');
    expect(within(row).getByText('Provider override')).toBeInTheDocument();
  });

  it('does not flag an override that matches the schedule pin', async () => {
    await renderTab({ 'layered-intelligence': { providerId: 'global-claude' } });
    const row = rowFor('layered-intelligence');
    expect(within(row).queryByText('Provider override')).toBeNull();
  });

  it('does not flag a task type with no app override', async () => {
    await renderTab();
    const row = rowFor('layered-intelligence');
    expect(within(row).queryByText('Provider override')).toBeNull();
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
