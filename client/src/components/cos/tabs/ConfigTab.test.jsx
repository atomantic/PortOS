import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Regression coverage for #2519 — failed CoS config calls must NOT flash a
// success toast, must keep the user in edit mode, and must revert optimistic
// state.
const api = vi.hoisted(() => ({
  updateCosConfig: vi.fn(),
  getCosBudgetUsage: vi.fn(),
  getPersistentMind: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const providerHook = vi.hoisted(() => ({
  setSelectedProviderId: vi.fn(),
  setSelectedModel: vi.fn(),
}));
const localLlm = vi.hoisted(() => ({
  getLocalLlmStatus: vi.fn(),
  getToolUseModels: vi.fn(),
}));

vi.mock('../../../services/api', () => api);
vi.mock('../../../services/apiLocalLlm', () => localLlm);
vi.mock('../../ui/Toast', () => ({ default: toast }));
// The provider/model selector hook fetches providers over the network — stub it
// so the test exercises only the config screen's own behavior.
vi.mock('../../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'codex', name: 'Codex', models: ['gpt-5'], defaultModel: 'gpt-5' }],
    availableModels: ['gpt-5'],
    setSelectedProviderId: providerHook.setSelectedProviderId,
    setSelectedModel: providerHook.setSelectedModel,
    selectedProviderId: '',
    selectedModel: '',
  }),
}));

const ConfigTab = (await import('./ConfigTab')).default;

const config = {
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxProcessMemoryMb: 2048,
  maxTotalProcesses: 50,
  alwaysOn: false,
  autoStart: false,
  improvementEnabled: true,
  proactiveMode: true,
  idleReviewEnabled: true,
};

const renderConfig = (props = {}) => render(
  <MemoryRouter>
    <ConfigTab
      config={config}
      onUpdate={vi.fn()}
      onEvaluate={vi.fn()}
      avatarStyle="svg"
      {...props}
    />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosBudgetUsage.mockResolvedValue({ usage: {} });
  localLlm.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
  localLlm.getToolUseModels.mockResolvedValue({ models: [] });
  api.getPersistentMind.mockResolvedValue({
    state: {
      enabled: true,
      started: true,
      status: 'waiting',
      queuedMessageCount: 2,
      lastCompletedAt: null,
      lastError: null,
      pauseReason: null,
    },
    profile: { enabled: true, providerId: 'codex', model: 'gpt-5' },
  });
});

describe('ConfigTab handleSave', () => {
  it('keeps the editor open and does not toast success when the save fails', async () => {
    api.updateCosConfig.mockRejectedValue(new Error('network down'));
    const onUpdate = vi.fn();
    renderConfig({ onUpdate });

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    // Still in edit mode — the Save button is present (editor did not close).
    expect(screen.getByRole('button', { name: /Save/i })).toBeInTheDocument();
  });

  it('closes the editor and toasts success when the save resolves', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    const onUpdate = vi.fn();
    renderConfig({ onUpdate });

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Configuration updated'));
    expect(onUpdate).toHaveBeenCalled();
    // The PUT must pass { silent: true } so the custom catch is the only error toast.
    expect(api.updateCosConfig).toHaveBeenCalledWith(expect.any(Object), { silent: true });
    // Editor closed — the Edit button is back.
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
  });

  it('saves the newly exposed scheduler and health controls together', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig();
    await screen.findByText('Waiting for the next wake');

    fireEvent.click(screen.getByRole('button', { name: /Edit settings/i }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Process count alert' }), { target: { value: '64' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'App review cooldown' }), { target: { value: '45' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Scheduled agent jobs/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTotalProcesses: 64,
        appReviewCooldownMs: 2_700_000,
        autonomousJobsEnabled: false,
      }),
      { silent: true },
    ));
  });

  it('preserves a valid sub-minute cooldown when saving unrelated settings', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig({ config: { ...config, appReviewCooldownMs: 30_000 } });

    fireEvent.click(screen.getByRole('button', { name: /Edit settings/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Dynamic avatar/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      expect.objectContaining({ appReviewCooldownMs: 30_000, dynamicAvatar: false }),
      { silent: true },
    ));
  });
});

describe('persistent mind profile', () => {
  it('starts disabled and saving its toggle sends a default-safe profile without starting a mind', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig();

    const toggle = screen.getByRole('checkbox', { name: 'Enable persistent mind profile' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        persistentMindProfile: expect.objectContaining({ enabled: true, thinkingInterface: 'text' }),
      }),
      { silent: true },
    ));
    expect(screen.getByText(/never starts a turn or downloads a model/i)).toBeInTheDocument();
  });
});

describe('Default Avatar Style dropdown', () => {
  it('shows the saved avatar style as text when not editing', async () => {
    renderConfig({ config: { ...config, avatarStyle: 'svg' } });
    await screen.findByText('Waiting for the next wake');

    expect(screen.queryByRole('combobox', { name: 'Default avatar' })).not.toBeInTheDocument();
    expect(screen.getByText('Digital (SVG)')).toBeInTheDocument();
  });

  it('stages dropdown selection locally without triggering immediate save call', async () => {
    renderConfig({ config: { ...config, avatarStyle: 'svg' } });
    await screen.findByText('Waiting for the next wake');

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));

    const select = screen.getByRole('combobox', { name: 'Default avatar' });
    expect(select).toBeEnabled();

    fireEvent.change(select, { target: { value: 'cyber' } });

    expect(select).toHaveValue('cyber');
    expect(api.updateCosConfig).not.toHaveBeenCalled();
  });

  it('includes staged avatarStyle in updateCosConfig payload on Save click', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    const onUpdate = vi.fn();
    renderConfig({ config: { ...config, avatarStyle: 'svg' }, onUpdate });

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));

    const select = screen.getByRole('combobox', { name: 'Default avatar' });
    fireEvent.change(select, { target: { value: 'cyber' } });

    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Configuration updated'));
    expect(api.updateCosConfig).toHaveBeenCalledWith(
      expect.objectContaining({ avatarStyle: 'cyber' }),
      { silent: true }
    );
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
  });

  it('reverts staged avatarStyle dropdown selection when Cancel is clicked', async () => {
    renderConfig({ config: { ...config, avatarStyle: 'svg' } });
    await screen.findByText('Waiting for the next wake');

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));

    const select = screen.getByRole('combobox', { name: 'Default avatar' });
    fireEvent.change(select, { target: { value: 'cyber' } });
    expect(select).toHaveValue('cyber');

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Default avatar' })).not.toBeInTheDocument();
    expect(screen.getByText('Digital (SVG)')).toBeInTheDocument();
  });
});

describe('persistent mind status', () => {
  it('shows the live supervisor state and links to the full mind workspace', async () => {
    renderConfig();

    expect(await screen.findByText('Waiting for the next wake')).toBeInTheDocument();
    expect(screen.getByText('Started')).toBeInTheDocument();
    expect(screen.getByLabelText('Queued persistent mind messages')).toHaveTextContent('2');
    expect(screen.getByRole('link', { name: /Open mind/i })).toHaveAttribute('href', '/cos/mind');
  });

  it('does not expose the retired global autonomy presets', async () => {
    renderConfig();

    await screen.findByText('Waiting for the next wake');
    expect(screen.queryByRole('button', { name: 'Standby' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'YOLO' })).not.toBeInTheDocument();
    expect(screen.getByText('Automation guardrails')).toBeInTheDocument();
  });
});

describe('boot startup compatibility', () => {
  it('shows alwaysOn as the boot setting and clears the legacy alias when saving it off', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig({ config: { ...config, alwaysOn: true, autoStart: true } });

    fireEvent.click(screen.getByRole('button', { name: /Edit settings/i }));
    const toggle = screen.getByRole('checkbox', { name: /Start on server boot/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysOn: false, autoStart: false }),
      { silent: true },
    ));
  });
});
