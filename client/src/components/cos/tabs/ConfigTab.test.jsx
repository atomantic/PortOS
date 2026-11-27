import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  updateCosConfig: vi.fn(),
  getCosBudgetUsage: vi.fn(),
  getPersistentMind: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const localLlm = vi.hoisted(() => ({
  getLocalLlmStatus: vi.fn(),
  getToolUseModels: vi.fn(),
  installLocalLlmModel: vi.fn(),
}));
// Embeddings are the shared settings.embeddings store (#18296), not CoS config.
const embeddingsApi = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  getEmbeddingConfig: vi.fn(),
}));
vi.mock('../../../services/apiSystem', () => ({ updateSettings: embeddingsApi.updateSettings }));
vi.mock('../../../services/apiMemory', () => ({ getEmbeddingConfig: embeddingsApi.getEmbeddingConfig }));

const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../../services/socket', () => ({ default: socket }));

vi.mock('../../../services/apiAgents.js', () => ({
  updateCosConfig: api.updateCosConfig,
  getCosBudgetUsage: api.getCosBudgetUsage,
  getPersistentMind: api.getPersistentMind,
}));
vi.mock('../../../services/apiLocalLlm', () => localLlm);
vi.mock('../../ui/Toast', () => ({ default: toast }));
const ConfigTab = (await import('./ConfigTab')).default;

const config = {
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxTotalProcesses: 50,
  alwaysOn: false,
  autoStart: false,
  improvementEnabled: true,
  idleReviewEnabled: true,
};

const configTree = (props = {}) => (
  <MemoryRouter>
    <ConfigTab
      config={config}
      onUpdate={vi.fn()}
      onEvaluate={vi.fn()}
      avatarStyle="svg"
      {...props}
    />
  </MemoryRouter>
);

const renderConfig = (props) => render(configTree(props));

beforeEach(() => {
  vi.clearAllMocks();
  embeddingsApi.getEmbeddingConfig.mockResolvedValue({ source: 'legacy', provider: 'lmstudio', model: 'text-embedding-nomic-embed-text-v2-moe', endpoint: null, disabled: false });
  api.getCosBudgetUsage.mockResolvedValue({ usage: {} });
  localLlm.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
  localLlm.getToolUseModels.mockResolvedValue({ models: [] });
});

describe('ConfigTab autosave', () => {
  it('makes controls available immediately and saves checkbox changes as partial updates', async () => {
    api.updateCosConfig.mockResolvedValue({ ...config, autonomousJobsEnabled: false });
    const onUpdate = vi.fn();
    renderConfig({ onUpdate });

    expect(screen.queryByRole('button', { name: /Edit settings/i })).not.toBeInTheDocument();
    const scheduledJobs = screen.getByRole('checkbox', { name: /Scheduled agent jobs/i });
    expect(scheduledJobs).toBeChecked();
    fireEvent.click(scheduledJobs);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { autonomousJobsEnabled: false },
      { silent: true },
    ));
    await waitFor(() => expect(screen.getByTestId('config-save-status')).toHaveTextContent('All changes saved'));
    expect(scheduledJobs).not.toBeChecked();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('commits numeric fields on blur and discards an incomplete value', async () => {
    api.updateCosConfig.mockResolvedValue({ ...config, maxTotalProcesses: 64 });
    renderConfig();

    const processCount = screen.getByRole('spinbutton', { name: 'Process count alert' });
    fireEvent.change(processCount, { target: { value: '' } });
    fireEvent.blur(processCount);
    expect(api.updateCosConfig).not.toHaveBeenCalled();
    expect(processCount).toHaveValue(50);

    fireEvent.change(processCount, { target: { value: '64' } });
    expect(api.updateCosConfig).not.toHaveBeenCalled();
    fireEvent.blur(processCount);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { maxTotalProcesses: 64 },
      { silent: true },
    ));
  });

  it('restores a failed auto-save and lets the user retry without a success toast', async () => {
    api.updateCosConfig
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue({ ...config, autonomousJobsEnabled: false });
    const onUpdate = vi.fn();
    renderConfig({ onUpdate });

    const scheduledJobs = screen.getByRole('checkbox', { name: /Scheduled agent jobs/i });
    fireEvent.click(scheduledJobs);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(scheduledJobs).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('Change those settings to retry');

    fireEvent.click(scheduledJobs);
    await waitFor(() => expect(screen.getByTestId('config-save-status')).toHaveTextContent('All changes saved'));
    expect(api.updateCosConfig).toHaveBeenCalledTimes(2);
    expect(api.updateCosConfig).toHaveBeenLastCalledWith({ autonomousJobsEnabled: false }, { silent: true });
    expect(scheduledJobs).not.toBeChecked();
  });

  it('serializes rapid changes so an older request cannot finish after the newer value', async () => {
    let resolveFirst;
    api.updateCosConfig
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ ...config, autonomousJobsEnabled: true });
    renderConfig();

    const scheduledJobs = screen.getByRole('checkbox', { name: /Scheduled agent jobs/i });
    fireEvent.click(scheduledJobs);
    fireEvent.click(scheduledJobs);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledTimes(1));
    expect(api.updateCosConfig).toHaveBeenNthCalledWith(1, { autonomousJobsEnabled: false }, { silent: true });
    await act(async () => {
      resolveFirst({ ...config, autonomousJobsEnabled: false });
    });
    expect(api.updateCosConfig).toHaveBeenCalledTimes(2);
    expect(api.updateCosConfig).toHaveBeenNthCalledWith(2, { autonomousJobsEnabled: true }, { silent: true });
    await waitFor(() => expect(screen.getByTestId('config-save-status')).toHaveTextContent('All changes saved'));
  });
});

// #5857 — the button's own contract is owned by this component, so it is pinned
// here against a direct render instead of through a full ChiefOfStaff page mount
// whose fan-out of mocked reads is what made the page suite flake. The page test
// keeps only the page-owned half (the toast + status-bubble result of the
// handler this button invokes).
describe('Force Evaluate button', () => {
  it('invokes the page handler once per click and explains what it does', async () => {
    const onEvaluate = vi.fn();
    await act(async () => { renderConfig({ onEvaluate }); });

    const button = screen.getByRole('button', { name: /Force Evaluate/i });
    expect(button).toHaveAttribute('title', 'Immediately check for pending tasks and spawn eligible agents');

    fireEvent.click(button);

    expect(onEvaluate).toHaveBeenCalledTimes(1);
    // Evaluating is the page's job — the button must not reach the API or toast
    // on its own, or a failed evaluate would double-report.
    expect(api.updateCosConfig).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stays available alongside the editable settings', async () => {
    const onEvaluate = vi.fn();
    await act(async () => { renderConfig({ onEvaluate }); });

    expect(screen.getByRole('checkbox', { name: /Scheduled agent jobs/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Force Evaluate/i }));
    expect(onEvaluate).toHaveBeenCalledTimes(1);
  });
});

describe('Default Avatar Style dropdown', () => {
  it('is immediately editable and saves the selected avatar style', async () => {
    api.updateCosConfig.mockResolvedValue({ ...config, avatarStyle: 'cyber' });
    renderConfig({ config: { ...config, avatarStyle: 'svg' } });

    const select = screen.getByRole('combobox', { name: 'Default avatar' });
    expect(select).toBeEnabled();
    expect(select).toHaveValue('svg');

    fireEvent.change(select, { target: { value: 'cyber' } });

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { avatarStyle: 'cyber' },
      { silent: true },
    ));
    expect(select).toHaveValue('cyber');
  });
});

describe('Rigged avatar records in the Default Avatar dropdown', () => {
  const riggedAvatars = [{
    id: 'image3d-1',
    name: 'Example Dancer',
    variant: 'rigged-image3d-1',
    assetUrl: '/api/avatar/model.glb?variant=rigged-image3d-1',
    clip: 'Dance',
    coverage: {
      availableClips: ['Dance'],
      coverageByState: {
        thinking: { covered: false, clip: null },
        ideating: { covered: true, clip: 'Dance' },
      },
      coveredStates: ['ideating'],
      missingStates: ['thinking'],
      complete: false,
    },
  }];

  it('offers verified animated records alongside the built-in styles', async () => {
    await act(async () => { renderConfig({ config: { ...config, avatarStyle: 'svg' }, riggedAvatars }); });

    const select = screen.getByRole('combobox', { name: 'Default avatar' });
    const labels = [...select.options].map((option) => option.text);
    expect(labels).toContain('Digital (SVG)');
    expect(labels.some((label) => label.includes('Example Dancer') && label.includes('rigged 3D'))).toBe(true);
  });

  it('shows the coverage note and saves a selected rigged record', async () => {
    api.updateCosConfig.mockResolvedValue({ ...config, avatarStyle: 'rigged-image3d-1' });
    renderConfig({ config: { ...config, avatarStyle: 'svg' }, riggedAvatars });

    const select = screen.getByRole('combobox', { name: 'Default avatar' });
    fireEvent.change(select, { target: { value: 'rigged-image3d-1' } });

    expect(await screen.findByText(/Covered: ideating/)).toBeInTheDocument();
    expect(screen.getByText(/Other states play Dance/)).toBeInTheDocument();

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { avatarStyle: 'rigged-image3d-1' },
      { silent: true },
    ));
  });

  it('warns when the saved rigged record is no longer offered', async () => {
    await act(async () => { renderConfig({ config: { ...config, avatarStyle: 'rigged-image3d-gone' }, riggedAvatars }); });

    expect(screen.getByText(/no longer available/)).toBeInTheDocument();
  });
});

describe('persistent mind status', () => {
  it('summarizes the saved profile and links to Mind Settings without attaching a second Mind subscriber', async () => {
    await act(async () => {
      renderConfig({
        config: { ...config, persistentMindProfile: { enabled: true, providerId: 'example-provider', model: 'example-model' } },
      });
    });

    expect(screen.getByText('AI profile · example-provider / example-model')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Mind Settings' })).toHaveAttribute('href', '/cos/mind?panel=settings');
    expect(screen.queryByRole('checkbox', { name: 'Enable persistent mind profile' })).not.toBeInTheDocument();
    expect(api.getPersistentMind).not.toHaveBeenCalled();
    expect(socket.on).not.toHaveBeenCalledWith('cos:mind:status', expect.any(Function));
  });

  it('does not expose the retired global autonomy presets', async () => {
    await act(async () => { renderConfig(); });

    expect(screen.queryByRole('button', { name: 'Standby' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'YOLO' })).not.toBeInTheDocument();
    expect(screen.getByText('Automation guardrails')).toBeInTheDocument();
  });
});

describe('domain guardrails and embeddings', () => {
  it('saves an autonomy mode change immediately', async () => {
    api.updateCosConfig.mockResolvedValue({ ...config, domainAutonomy: { cos: 'off' } });
    renderConfig();

    fireEvent.click(within(screen.getByRole('group', { name: 'CoS auto-run mode' })).getByRole('button', { name: 'Off' }));

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { domainAutonomy: { cos: 'off' } },
      { silent: true },
    ));
  });

  it('restores a failed autonomy mode and accepts the same selection on retry', async () => {
    const savedConfig = { ...config, domainAutonomy: { cos: 'dry-run' } };
    api.updateCosConfig
      .mockRejectedValueOnce(new Error('autonomy save failed'))
      .mockResolvedValue({ ...config, domainAutonomy: { cos: 'off' } });
    renderConfig({ config: savedConfig });
    const group = within(screen.getByRole('group', { name: 'CoS auto-run mode' }));
    const off = group.getByRole('button', { name: 'Off' });
    const dryRun = group.getByRole('button', { name: 'Dry-run' });

    fireEvent.click(off);
    expect(off).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Change those settings to retry'));
    expect(dryRun).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(off);
    await waitFor(() => expect(screen.getByTestId('config-save-status')).toHaveTextContent('All changes saved'));
    expect(api.updateCosConfig.mock.calls).toEqual([
      [{ domainAutonomy: { cos: 'off' } }, { silent: true }],
      [{ domainAutonomy: { cos: 'off' } }, { silent: true }],
    ]);
    expect(off).toHaveAttribute('aria-pressed', 'true');
  });

  it.each(['fails', 'succeeds'])('keeps a newer autonomy edit pending when the previous save %s', async (firstOutcome) => {
    const firstSucceeds = firstOutcome === 'succeeds';
    const first = Promise.withResolvers();
    const newer = Promise.withResolvers();
    api.updateCosConfig.mockReturnValueOnce(first.promise).mockReturnValueOnce(newer.promise);
    renderConfig({ config: { ...config, domainAutonomy: { cos: 'execute' } } });
    const group = within(screen.getByRole('group', { name: 'CoS auto-run mode' }));
    const off = group.getByRole('button', { name: 'Off' });
    const dryRun = group.getByRole('button', { name: 'Dry-run' });
    const execute = group.getByRole('button', { name: 'Execute' });

    fireEvent.click(off);
    fireEvent.click(dryRun);
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledTimes(1));

    await act(async () => {
      if (firstSucceeds) first.resolve({ ...config, domainAutonomy: { cos: 'off' } });
      else first.reject(new Error('first failed'));
    });
    expect(api.updateCosConfig).toHaveBeenLastCalledWith({ domainAutonomy: { cos: 'dry-run' } }, { silent: true });
    expect(dryRun).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('config-save-status')).toHaveTextContent('Saving changes');

    await act(async () => { newer.reject(new Error('second failed')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Change those settings to retry');
    expect(firstSucceeds ? off : execute).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders Creative orchestrator inheriting CoS by default and saves explicit overrides and Inherit CoS clears', async () => {
    api.updateCosConfig
      .mockResolvedValueOnce({ ...config, domainAutonomy: { cos: 'dry-run', creative: 'execute' } })
      .mockResolvedValue({ ...config, domainAutonomy: { cos: 'dry-run', creative: null } });
    const { rerender } = renderConfig({
      config: { ...config, domainAutonomy: { cos: 'dry-run' } },
    });

    const group = screen.getByRole('group', { name: 'Creative orchestrator mode' });
    const inheritButton = within(group).getByRole('button', { name: 'Inherit CoS auto-run' });
    expect(inheritButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Inheriting CoS \(Dry-run\)/)).toBeInTheDocument();

    fireEvent.click(within(group).getByRole('button', { name: 'Execute' }));
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { domainAutonomy: { creative: 'execute' } },
      { silent: true },
    ));

    rerender(configTree({ config: { ...config, domainAutonomy: { cos: 'dry-run', creative: 'execute' } } }));
    expect(within(group).getByRole('button', { name: 'Execute' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Inherit CoS auto-run' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(within(group).getByRole('button', { name: 'Inherit CoS auto-run' }));
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenLastCalledWith(
      { domainAutonomy: { creative: null } },
      { silent: true },
    ));
    expect(within(group).getByRole('button', { name: 'Inherit CoS auto-run' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('saves the recommended embedding model to the shared settings.embeddings store, not CoS config', async () => {
    localLlm.installLocalLlmModel.mockResolvedValue({ success: true });
    embeddingsApi.updateSettings.mockResolvedValue({});
    renderConfig();

    // The section shows the resolved backend and links to its one editor.
    expect(await screen.findByText(/legacy Chief of Staff embedding provider/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configure embeddings' })).toHaveAttribute('href', '/models/embeddings');
    expect(screen.queryByRole('combobox', { name: 'Embedding provider' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Download nomic-embed-text' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use for embeddings' }));

    await waitFor(() => expect(embeddingsApi.updateSettings).toHaveBeenCalledWith(
      { embeddings: { provider: 'ollama', model: 'nomic-embed-text' } },
      { silent: true },
    ));
    expect(api.updateCosConfig).not.toHaveBeenCalled();
    // The notice re-reads the backend it just switched to.
    await waitFor(() => expect(embeddingsApi.getEmbeddingConfig).toHaveBeenCalledTimes(2));
  });

  it('saves a budget cap when its number field loses focus', async () => {
    api.updateCosConfig.mockResolvedValue({ ...config, domainBudgets: { brain: { maxActionsPerDay: 5 } } });
    renderConfig();

    const actionsPerDay = screen.getAllByRole('spinbutton', { name: 'Actions/day' })[0];
    fireEvent.change(actionsPerDay, { target: { value: '5' } });
    fireEvent.blur(actionsPerDay);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { domainBudgets: { brain: { maxActionsPerDay: 5 } } },
      { silent: true },
    ));
  });

  it('restores a failed budget cap and accepts the same value on retry', async () => {
    const savedConfig = { ...config, domainBudgets: { brain: { maxActionsPerDay: 5 } } };
    api.updateCosConfig
      .mockRejectedValueOnce(new Error('budget save failed'))
      .mockResolvedValue({ ...config, domainBudgets: { brain: { maxActionsPerDay: null } } });
    renderConfig({ config: savedConfig });
    const actionsPerDay = () => screen.getAllByRole('spinbutton', { name: 'Actions/day' })[0];

    fireEvent.change(actionsPerDay(), { target: { value: '' } });
    fireEvent.blur(actionsPerDay());
    expect(actionsPerDay()).toHaveDisplayValue('');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Change those settings to retry'));
    expect(actionsPerDay()).toHaveValue(5);

    fireEvent.change(actionsPerDay(), { target: { value: '' } });
    fireEvent.blur(actionsPerDay());
    await waitFor(() => expect(screen.getByTestId('config-save-status')).toHaveTextContent('All changes saved'));
    expect(api.updateCosConfig.mock.calls).toEqual([
      [{ domainBudgets: { brain: { maxActionsPerDay: null } } }, { silent: true }],
      [{ domainBudgets: { brain: { maxActionsPerDay: null } } }, { silent: true }],
    ]);
    expect(actionsPerDay()).toHaveDisplayValue('');
  });
});

describe('approval gates', () => {
  it('saves confidence thresholds and a safety-kind change', async () => {
    const approvalConfig = {
      ...config,
      confidenceAutoApproval: { enabled: false, highThreshold: 80, lowThreshold: 50, minSamples: 5 },
    };
    api.updateCosConfig
      .mockResolvedValueOnce(approvalConfig)
      .mockResolvedValueOnce({ ...approvalConfig, confidenceAutoApproval: { ...approvalConfig.confidenceAutoApproval, lowThreshold: 30 } })
      .mockResolvedValue({ ...approvalConfig, safetyKindApproval: { alwaysApproveKinds: ['content', 'federation', 'external-pr'] } });
    renderConfig({
      config: {
        ...config,
        confidenceAutoApproval: { enabled: true, highThreshold: 80, lowThreshold: 50, minSamples: 5 },
        safetyKindApproval: { enabled: true, alwaysApproveKinds: ['content', 'publish', 'federation', 'external-pr'] },
      },
    });
    await screen.findByText('Approval gates');

    expect(screen.getByRole('checkbox', { name: /Confidence auto-approval/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Publish/ })).toBeChecked();

    fireEvent.click(screen.getByRole('checkbox', { name: /Confidence auto-approval/ }));
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { confidenceAutoApproval: { enabled: false } },
      { silent: true },
    ));

    const low = screen.getByRole('spinbutton', { name: 'Low confidence' });
    fireEvent.change(low, { target: { value: '30' } });
    fireEvent.blur(low);
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { confidenceAutoApproval: { lowThreshold: 30 } },
      { silent: true },
    ));

    fireEvent.click(screen.getByRole('checkbox', { name: /^Publish/ }));
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { safetyKindApproval: { alwaysApproveKinds: ['content', 'federation', 'external-pr'] } },
      { silent: true },
    ));
  });

  it('rolls a failed confidence edit back to a refreshed server value', async () => {
    const pending = Promise.withResolvers();
    api.updateCosConfig.mockReturnValueOnce(pending.promise);
    const { rerender } = renderConfig({ config: { ...config, confidenceAutoApproval: { lowThreshold: 40 } } });
    const low = screen.getByRole('spinbutton', { name: 'Low confidence' });

    fireEvent.change(low, { target: { value: '30' } });
    fireEvent.blur(low);
    rerender(configTree({ config: { ...config, confidenceAutoApproval: { lowThreshold: 45 } } }));
    expect(low).toHaveValue(30);

    await act(async () => { pending.reject(new Error('confidence save failed')); });
    expect(screen.getByRole('alert')).toHaveTextContent('Change those settings to retry');
    expect(low).toHaveValue(45);
  });

  it('excludes a failed safety kind change from the next queued full-list write', async () => {
    const first = Promise.withResolvers();
    const newer = Promise.withResolvers();
    api.updateCosConfig.mockReturnValueOnce(first.promise).mockReturnValueOnce(newer.promise);
    renderConfig();
    const publish = screen.getByRole('checkbox', { name: /^Publish/ });
    const federation = screen.getByRole('checkbox', { name: /^Federation/ });

    fireEvent.click(publish);
    fireEvent.click(federation);
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledTimes(1));
    expect(publish).not.toBeChecked();
    expect(federation).not.toBeChecked();

    await act(async () => { first.reject(new Error('safety save failed')); });
    expect(api.updateCosConfig).toHaveBeenLastCalledWith(
      { safetyKindApproval: { alwaysApproveKinds: ['content', 'publish', 'external-pr'] } },
      { silent: true },
    );
    expect(publish).toBeChecked();
    expect(federation).not.toBeChecked();

    await act(async () => {
      newer.resolve({ ...config, safetyKindApproval: { alwaysApproveKinds: ['content', 'publish', 'external-pr'] } });
    });
    expect(publish).toBeChecked();
    expect(federation).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('Change those settings to retry');
  });

  it('shows a saved safety list that omits a kind', async () => {
    renderConfig({
      config: {
        ...config,
        safetyKindApproval: { enabled: false, alwaysApproveKinds: ['content'] },
      },
    });
    await screen.findByText('Approval gates');
    expect(screen.getByRole('checkbox', { name: /Outward safety approval/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Content/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Federation/ })).not.toBeChecked();
  });
});

describe('boot startup compatibility', () => {
  it('shows alwaysOn as the boot setting and clears the legacy alias when autosaving it off', async () => {
    api.updateCosConfig.mockResolvedValue({ ...config, alwaysOn: false, autoStart: false });
    renderConfig({ config: { ...config, alwaysOn: true, autoStart: true } });

    const toggle = screen.getByRole('checkbox', { name: /Start on server boot/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { alwaysOn: false, autoStart: false },
      { silent: true },
    ));
  });
});
