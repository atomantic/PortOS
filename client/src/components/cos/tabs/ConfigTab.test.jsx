import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Regression coverage for #2519 — failed CoS config calls must NOT flash a
// success toast and must leave the user's value visible with a retry cue.
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

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler); },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: vi.fn(),
    emitServer: (event, payload) => handlers.get(event)?.forEach(handler => handler(payload)),
    listenerCount: event => handlers.get(event)?.size ?? 0,
  };
});
vi.mock('../../../services/socket', () => ({ default: socket }));

vi.mock('../../../services/apiAgents.js', () => ({
  updateCosConfig: api.updateCosConfig,
  getCosBudgetUsage: api.getCosBudgetUsage,
  getPersistentMind: api.getPersistentMind,
}));
vi.mock('../../../services/apiLocalLlm', () => localLlm);
vi.mock('../../ui/Toast', () => ({ default: toast }));
// PersistentMindProfileControls picks a provider over the network — stub the
// hook so the test exercises only the config screen's own behavior.
vi.mock('../../../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'codex', name: 'Codex', models: ['gpt-5'], defaultModel: 'gpt-5' }],
    availableModels: ['gpt-5'],
    setSelectedProviderId: () => {},
    setSelectedModel: () => {},
    selectedProviderId: '',
    selectedModel: '',
  }),
}));

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
  embeddingsApi.getEmbeddingConfig.mockResolvedValue({ source: 'legacy', provider: 'lmstudio', model: 'text-embedding-nomic-embed-text-v2-moe', endpoint: null, disabled: false });
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

describe('ConfigTab autosave', () => {
  it('makes controls available immediately and saves checkbox changes as partial updates', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    const onUpdate = vi.fn();
    renderConfig({ onUpdate });
    await screen.findByText('Waiting for the next wake');

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
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig();
    await screen.findByText('Waiting for the next wake');

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

  it('keeps a failed auto-save visible and reports the failure without a success toast', async () => {
    api.updateCosConfig.mockRejectedValue(new Error('network down'));
    const onUpdate = vi.fn();
    renderConfig({ onUpdate });

    const scheduledJobs = screen.getByRole('checkbox', { name: /Scheduled agent jobs/i });
    fireEvent.click(scheduledJobs);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(scheduledJobs).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent('Change those settings to retry');
  });

  it('serializes rapid changes so an older request cannot finish after the newer value', async () => {
    let resolveFirst;
    api.updateCosConfig
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue({ success: true });
    renderConfig();
    await screen.findByText('Waiting for the next wake');

    const scheduledJobs = screen.getByRole('checkbox', { name: /Scheduled agent jobs/i });
    fireEvent.click(scheduledJobs);
    fireEvent.click(scheduledJobs);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledTimes(1));
    expect(api.updateCosConfig).toHaveBeenNthCalledWith(1, { autonomousJobsEnabled: false }, { silent: true });
    await act(async () => {
      resolveFirst({ success: true });
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
    renderConfig({ onEvaluate });
    await screen.findByText('Waiting for the next wake');

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
    renderConfig({ onEvaluate });
    await screen.findByText('Waiting for the next wake');

    expect(screen.getByRole('checkbox', { name: /Scheduled agent jobs/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Force Evaluate/i }));
    expect(onEvaluate).toHaveBeenCalledTimes(1);
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
  it('is immediately editable and saves the selected avatar style', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig({ config: { ...config, avatarStyle: 'svg' } });
    await screen.findByText('Waiting for the next wake');

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
    renderConfig({ config: { ...config, avatarStyle: 'svg' }, riggedAvatars });
    await screen.findByText('Waiting for the next wake');

    const select = screen.getByRole('combobox', { name: 'Default avatar' });
    const labels = [...select.options].map((option) => option.text);
    expect(labels).toContain('Digital (SVG)');
    expect(labels.some((label) => label.includes('Example Dancer') && label.includes('rigged 3D'))).toBe(true);
  });

  it('shows the coverage note and saves a selected rigged record', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig({ config: { ...config, avatarStyle: 'svg' }, riggedAvatars });
    await screen.findByText('Waiting for the next wake');

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
    renderConfig({ config: { ...config, avatarStyle: 'rigged-image3d-gone' }, riggedAvatars });
    await screen.findByText('Waiting for the next wake');

    expect(screen.getByText(/no longer available/)).toBeInTheDocument();
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

describe('domain guardrails and embeddings', () => {
  it('saves an autonomy mode change immediately', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig();
    await screen.findByText('Waiting for the next wake');

    fireEvent.click(within(screen.getByRole('group', { name: 'CoS auto-run mode' })).getByRole('button', { name: 'Off' }));

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { domainAutonomy: { cos: 'off' } },
      { silent: true },
    ));
  });

  it('renders Creative orchestrator inheriting CoS by default and saves explicit overrides and Inherit CoS clears', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    const { rerender } = renderConfig({
      config: { ...config, domainAutonomy: { cos: 'dry-run' } },
    });
    await screen.findByText('Waiting for the next wake');

    const group = screen.getByRole('group', { name: 'Creative orchestrator mode' });
    const inheritButton = within(group).getByRole('button', { name: 'Inherit CoS auto-run' });
    expect(inheritButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Inheriting CoS \(Dry-run\)/)).toBeInTheDocument();

    fireEvent.click(within(group).getByRole('button', { name: 'Execute' }));
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { domainAutonomy: { creative: 'execute' } },
      { silent: true },
    ));

    rerender(
      <MemoryRouter>
        <ConfigTab
          config={{ ...config, domainAutonomy: { cos: 'dry-run', creative: 'execute' } }}
          onUpdate={vi.fn()}
          onEvaluate={vi.fn()}
          avatarStyle="svg"
        />
      </MemoryRouter>,
    );
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
    await screen.findByText('Waiting for the next wake');

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
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig();
    await screen.findByText('Waiting for the next wake');

    const actionsPerDay = screen.getAllByRole('spinbutton', { name: 'Actions/day' })[0];
    fireEvent.change(actionsPerDay, { target: { value: '5' } });
    fireEvent.blur(actionsPerDay);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { domainBudgets: { brain: { maxActionsPerDay: 5 } } },
      { silent: true },
    ));
  });
});

describe('approval gates', () => {
  it('saves confidence thresholds and a safety-kind change', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
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
    api.updateCosConfig.mockResolvedValue({ success: true });
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

it('reconciles Mind status on events, reconnect and reshow without polling or reads after unmount', async () => {
  const view = renderConfig();
  await screen.findByText('Waiting for the next wake');
  vi.useFakeTimers();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getPersistentMind).toHaveBeenCalledTimes(1);
    const snapshot = { enabled: true, started: true, status: 'thinking', activeTurnId: 'example-turn', queuedMessageCount: 9 };
    await act(async () => {
      socket.emitServer('cos:mind:event', { kind: 'thought' });
      socket.emitServer('cos:mind:status', snapshot);
    });
    expect(api.getPersistentMind).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Queued persistent mind messages')).toHaveTextContent('9');
    expect(screen.getByTestId('mind-thought-status')).toHaveTextContent('Thinking with gpt-5');

    api.getPersistentMind.mockResolvedValue({ state: { queuedMessageCount: 4 }, profile: {} });
    for (const event of ['cos:config:changed', 'connect']) {
      const before = api.getPersistentMind.mock.calls.length;
      await act(async () => socket.emitServer(event));
      expect(api.getPersistentMind).toHaveBeenCalledTimes(before + 1);
      expect(screen.getByLabelText('Queued persistent mind messages')).toHaveTextContent('4');
    }
    const before = api.getPersistentMind.mock.calls.length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => socket.emitServer('cos:mind:status', snapshot));
    expect(screen.getByLabelText('Queued persistent mind messages')).toHaveTextContent('4');
    expect(api.getPersistentMind).toHaveBeenCalledTimes(before);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(api.getPersistentMind).toHaveBeenCalledTimes(before + 1);
    view.unmount();
    expect(socket.listenerCount('cos:mind:status')).toBe(0);
    await act(async () => {
      socket.emitServer('connect');
      socket.emitServer('cos:mind:event');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.getPersistentMind).toHaveBeenCalledTimes(before + 1);
  } finally {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  }
});

it('retains the initial profile when a socket snapshot arrives during loading', async () => {
  const { promise, resolve } = Promise.withResolvers();
  api.getPersistentMind.mockReturnValueOnce(promise);
  renderConfig();
  expect(screen.getByText('Loading…')).toBeInTheDocument();
  await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(1));

  await act(async () => {
    socket.emitServer('cos:mind:status', { status: 'thinking', activeTurnId: 'example-turn', started: true, queuedMessageCount: 6 });
    resolve({ state: { status: 'waiting', queuedMessageCount: 2 }, profile: { model: 'gpt-5' } });
  });

  expect(screen.getByTestId('mind-thought-status')).toHaveTextContent('Thinking with gpt-5');
  expect(screen.getByLabelText('Queued persistent mind messages')).toHaveTextContent('6');
  expect(api.getPersistentMind).toHaveBeenCalledTimes(1);
});
