import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// Regression coverage for #2519 — failed CoS config calls must NOT flash a
// success toast, must keep the user in edit mode, and must revert optimistic
// state.
const api = vi.hoisted(() => ({
  updateCosConfig: vi.fn(),
  getCosBudgetUsage: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));
// The provider/model selector hook fetches providers over the network — stub it
// so the test exercises only the config-save / level-change handlers.
vi.mock('../../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [],
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
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
  autoStart: false,
  improvementEnabled: true,
  proactiveMode: true,
  idleReviewEnabled: true,
  immediateExecution: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosBudgetUsage.mockResolvedValue({ usage: {} });
});

describe('ConfigTab handleSave', () => {
  it('keeps the editor open and does not toast success when the save fails', async () => {
    api.updateCosConfig.mockRejectedValue(new Error('network down'));
    const onUpdate = vi.fn();
    render(<ConfigTab config={config} onUpdate={onUpdate} onEvaluate={vi.fn()} avatarStyle="svg" setAvatarStyle={vi.fn()} />);

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
    render(<ConfigTab config={config} onUpdate={onUpdate} onEvaluate={vi.fn()} avatarStyle="svg" setAvatarStyle={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Edit/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Configuration updated'));
    expect(onUpdate).toHaveBeenCalled();
    // The PUT must pass { silent: true } so the custom catch is the only error toast.
    expect(api.updateCosConfig).toHaveBeenCalledWith(expect.any(Object), { silent: true });
    // Editor closed — the Edit button is back.
    expect(screen.getByRole('button', { name: /Edit/i })).toBeInTheDocument();
  });
});

describe('ConfigTab handleLevelChange', () => {
  // Reads the non-editing value span rendered next to a ConfigRow label.
  const rowValue = (label) => within(screen.getByText(label).closest('div')).getByText;

  it('does not toast success when the autonomy level change fails', async () => {
    api.updateCosConfig.mockRejectedValue(new Error('boom'));
    render(<ConfigTab config={config} onUpdate={vi.fn()} onEvaluate={vi.fn()} avatarStyle="svg" setAvatarStyle={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Standby' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reverts the optimistic form params when the level change fails', async () => {
    api.updateCosConfig.mockRejectedValue(new Error('boom'));
    render(<ConfigTab config={config} onUpdate={vi.fn()} onEvaluate={vi.fn()} avatarStyle="svg" setAvatarStyle={vi.fn()} />);

    // Baseline: Max Concurrent Agents shows the config value (3).
    expect(rowValue('Max Concurrent Agents')('3')).toBeInTheDocument();

    // Standby sets maxConcurrentAgents: 1 optimistically; on failure it must revert
    // back to 3 (without the revert this row would be stuck showing 1).
    fireEvent.click(screen.getByRole('button', { name: 'Standby' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    expect(rowValue('Max Concurrent Agents')('3')).toBeInTheDocument();
  });

  it('keeps the optimistic params and toasts the label (silently) after the change resolves', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    render(<ConfigTab config={config} onUpdate={vi.fn()} onEvaluate={vi.fn()} avatarStyle="svg" setAvatarStyle={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Standby' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Autonomy level set to Standby'));
    // Optimistic value persisted (Standby → maxConcurrentAgents: 1).
    expect(rowValue('Max Concurrent Agents')('1')).toBeInTheDocument();
    // The PUT must pass { silent: true } so the custom catch is the only error toast.
    expect(api.updateCosConfig).toHaveBeenCalledWith(
      expect.objectContaining({ maxConcurrentAgents: 1 }),
      { silent: true },
    );
  });

  it('does not clobber a newer successful preset when an earlier request fails late', async () => {
    // Standby's PUT stays pending; YOLO's resolves first. When Standby then
    // rejects, its rollback must NOT restore stale values over YOLO's now-
    // persisted preset — only keys still holding Standby's optimistic value revert.
    let rejectStandby;
    api.updateCosConfig.mockImplementation((params) => {
      if (params.maxConcurrentAgents === 1) {
        return new Promise((_, reject) => { rejectStandby = () => reject(new Error('boom')); });
      }
      return Promise.resolve({ success: true });
    });
    render(<ConfigTab config={config} onUpdate={vi.fn()} onEvaluate={vi.fn()} avatarStyle="svg" setAvatarStyle={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Standby' })); // optimistic → 1 (pending)
    fireEvent.click(screen.getByRole('button', { name: 'YOLO' }));    // optimistic → 5 (resolves)

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Autonomy level set to YOLO'));
    expect(rowValue('Max Concurrent Agents')('5')).toBeInTheDocument();

    rejectStandby();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('boom'));
    // YOLO's value survives — the stale Standby rollback must not reset it to 3.
    expect(rowValue('Max Concurrent Agents')('5')).toBeInTheDocument();
  });
});
