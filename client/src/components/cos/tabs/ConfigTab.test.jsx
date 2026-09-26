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
const providerHook = vi.hoisted(() => ({
  setSelectedProviderId: vi.fn(),
  setSelectedModel: vi.fn(),
  // #8348 — the render-loop guard below flips this on to give the setters a
  // new identity on every render (matching ChiefOfStaff.test.jsx's mock),
  // then reads renderCount (bumped once per hook call, i.e. once per render).
  unstableSetters: false,
  renderCount: 0,
}));
const localLlm = vi.hoisted(() => ({
  getLocalLlmStatus: vi.fn(),
  getToolUseModels: vi.fn(),
}));

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler); },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: vi.fn(),
    emitServer: event => handlers.get(event)?.forEach(handler => handler()),
  };
});
vi.mock('../../../services/socket', () => ({ default: socket }));

vi.mock('../../../services/api', () => api);
vi.mock('../../../services/apiLocalLlm', () => localLlm);
vi.mock('../../ui/Toast', () => ({ default: toast }));
// The provider/model selector hook fetches providers over the network — stub it
// so the test exercises only the config screen's own behavior.
vi.mock('../../../hooks/useProviderModels', () => ({
  default: () => {
    providerHook.renderCount += 1;
    // A real render loop never settles on its own — cap it here so a
    // regression fails in milliseconds with a clear error instead of
    // spinning the worker toward the heap limit (#8327/#8348).
    if (providerHook.unstableSetters && providerHook.renderCount > 25) {
      throw new Error(`ConfigTab render loop: useProviderModels invoked ${providerHook.renderCount} times`);
    }
    return {
      providers: [{ id: 'codex', name: 'Codex', models: ['gpt-5'], defaultModel: 'gpt-5' }],
      availableModels: ['gpt-5'],
      setSelectedProviderId: providerHook.unstableSetters
        ? (id) => providerHook.setSelectedProviderId(id)
        : providerHook.setSelectedProviderId,
      setSelectedModel: providerHook.unstableSetters
        ? (model) => providerHook.setSelectedModel(model)
        : providerHook.setSelectedModel,
      selectedProviderId: '',
      selectedModel: '',
    };
  },
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
  providerHook.unstableSetters = false;
  providerHook.renderCount = 0;
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
      await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledTimes(2));
    });
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

describe('domain guardrails and embedding provider autosave', () => {
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

  it('saves an embedding provider selection immediately', async () => {
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig();
    await screen.findByText('Waiting for the next wake');

    fireEvent.change(screen.getByRole('combobox', { name: 'Embedding provider' }), { target: { value: 'codex' } });

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { embeddingProviderId: 'codex', embeddingModel: '' },
      { silent: true },
    ));
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

// Regression coverage for #8327/#8348 — this file's own useProviderModels mock
// returns STABLE setters, so it can never reproduce the render loop that fix
// ade6d692d resolved. Only ChiefOfStaff.test.jsx's mock (fresh vi.fn() setters
// per render) triggered it there, surfacing as a worker that grows to the
// heap limit with no assertion pointing at ConfigTab. This test reproduces
// the unstable-identity condition directly against ConfigTab so a regression
// fails fast, here, with a clear render-count signal.
describe('render loop guard (#8348)', () => {
  it('settles instead of looping when the provider hook setters change identity every render', async () => {
    providerHook.unstableSetters = true;
    api.updateCosConfig.mockResolvedValue({ success: true });
    renderConfig({ config: { ...config, embeddingProviderId: 'codex', embeddingModel: 'gpt-5' } });
    await screen.findByText('Waiting for the next wake');

    // "Waiting for the next wake" landing only proves the persistent-mind
    // fetch resolved — the config-panel's OWN provider/model resync effect
    // (re-run on every unstable setter identity) and the independent budget-
    // usage fetch can each still have one more no-op flush in flight. Treat
    // render count as settled only once two consecutive flushes agree,
    // bounded so a genuine reintroduced loop (#8348) fails loudly here
    // instead of silently accepting a runaway climb (see also the mocked
    // hook's own >25 hard cap above).
    let settledCount = providerHook.renderCount;
    let settled = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential settle-detection, not parallelizable
      await act(async () => {});
      const nextCount = providerHook.renderCount;
      if (nextCount === settledCount) {
        settled = true;
        break;
      }
      settledCount = nextCount;
    }
    expect(settled).toBe(true);
    expect(settledCount).toBeLessThan(20);

    // One more flush: a real loop keeps climbing here, a settled component does not.
    await act(async () => {});
    expect(providerHook.renderCount).toBe(settledCount);

    // The guard must not pass just because the effect stopped running — the
    // saved embedding pick still has to reach the provider hook.
    expect(providerHook.setSelectedProviderId).toHaveBeenCalledWith('codex');
    expect(providerHook.setSelectedModel).toHaveBeenCalledWith('gpt-5');
  });
});

it('reconciles Mind status on events, reconnect and reshow without polling or reads after unmount', async () => {
  const view = renderConfig();
  await screen.findByText('Waiting for the next wake');
  vi.useFakeTimers();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getPersistentMind).toHaveBeenCalledTimes(1);
    api.getPersistentMind.mockResolvedValue({ state: { queuedMessageCount: 9 }, profile: {} });
    for (const event of ['cos:mind:event', 'cos:mind:status', 'connect']) {
      const before = api.getPersistentMind.mock.calls.length;
      await act(async () => socket.emitServer(event));
      expect(api.getPersistentMind).toHaveBeenCalledTimes(before + 1);
      expect(screen.getByLabelText('Queued persistent mind messages')).toHaveTextContent('9');
    }
    const before = api.getPersistentMind.mock.calls.length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => socket.emitServer('cos:mind:status'));
    expect(api.getPersistentMind).toHaveBeenCalledTimes(before);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(api.getPersistentMind).toHaveBeenCalledTimes(before + 1);
    view.unmount();
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
