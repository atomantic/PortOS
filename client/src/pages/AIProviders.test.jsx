import {
  api,
  localModels,
  toast,
  mountPage,
  renderPage,
  openEditorTab,
  openHeaderMenu,
  clickLoadSamples,
  missingRuntime,
} from './AIProviders.test.fixture.jsx';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { findEnabledByRole } from '../test/enabledBarrier.js';
import { __resetProviderCatalogCache } from '../hooks/useProviderCatalog';

const withFailedSampleRequest = async (status, body, run) => {
  const { createProvider } = await vi.importActual('../services/apiProviders.js');
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify(body), { status }));
  try {
    await api.createProvider.withImplementation(createProvider, run);
  } finally {
    fetchMock.mockRestore();
  }
};

describe('AIProviders page load error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getCodexAccount.mockImplementation(() => new Promise(() => {}));
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  });

  it('renders one CLI/TUI card with one install check, explicit default modes and a TUI shell link', async () => {
    const executionModes = [{ id: 'example', type: 'cli' }, { id: 'example-tui', type: 'tui' }];
    api.getProviders.mockResolvedValue({ activeProvider: 'example', providers: [
      { id: 'example', name: 'Example CLI', type: 'cli', command: 'opencode', enabled: true, models: ['model-a'], executionModes },
      { id: 'example-tui', name: 'Example TUI', type: 'tui', command: 'opencode', enabled: true, models: ['model-a'], tuiCommandLine: 'opencode', executionModes },
      { id: 'example-api', name: 'Example API', type: 'api', endpoint: 'http://192.0.2.10:11434', enabled: true, models: ['remote-model'] },
    ] });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: missingRuntime } });
    await renderPage();
    expect(await screen.findByRole('heading', { name: 'Example', exact: true })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Example API' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Install OpenCode CLI/ })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Launch in Shell' })).toHaveAttribute('href', '/shell?provider=example-tui');
    expect(screen.getByRole('button', { name: 'CLI default' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Set TUI default' }));
    await waitFor(() => expect(api.setActiveProvider).toHaveBeenCalledWith('example-tui'));
    expect(await screen.findByRole('button', { name: 'TUI default' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Set CLI default' }));
    await waitFor(() => expect(api.setActiveProvider).toHaveBeenLastCalledWith('example'));
  });

  it('gates the CLI default on transport consent but leaves the TUI default selectable', async () => {
    const executionModes = [{ id: 'codex', type: 'cli' }, { id: 'codex-tui', type: 'tui' }];
    api.getCodexAccount.mockResolvedValue({ readiness: { status: 'ready' } });
    api.getCodexModels.mockResolvedValue({ models: null });
    api.getProviders.mockResolvedValue({ activeProvider: null, providers: [
      { id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', enabled: true, textTransportEnabled: true, executionModes },
      { id: 'codex-tui', name: 'Codex TUI', type: 'tui', command: 'codex', enabled: true, textTransportEnabled: false, executionModes },
    ] });
    await renderPage();
    await findEnabledByRole('button', { name: 'Set CLI default' });
    expect(screen.getByRole('button', { name: 'Set TUI default' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Set TUI default' }));
    await waitFor(() => expect(api.setActiveProvider).toHaveBeenCalledWith('codex-tui'));
  });

  it('offers an install button on the card of a provider whose CLI is missing', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-ollama', name: 'OpenCode Ollama', type: 'cli', command: 'opencode', args: ['run'], enabled: true }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: missingRuntime } });

    await renderPage();

    const install = await screen.findByRole('button', { name: /Install OpenCode CLI/ });
    expect(install).toBeEnabled();
    fireEvent.click(install);
    const modal = await screen.findByTestId('runtime-install-modal');
    expect(modal).toHaveAttribute('data-runtime', 'opencode');
    expect(modal).toHaveAttribute('data-stream-method', 'POST');
    expect(modal).toHaveAttribute('data-flush-ms', '250');
  });

  it('opens the shared installer when a Harnesses card starts a CLI install', async () => {
    __resetProviderCatalogCache();
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
    api.getProviderRuntimes.mockResolvedValue({
      runtimes: {
        pi: {
          id: 'pi',
          label: 'Pi Coding Agent CLI',
          vendor: 'pi',
          installed: false,
          installable: true,
          method: 'npm',
        },
      },
    });
    api.getProviderCatalog.mockResolvedValue({
      harnesses: [{ id: 'pi', label: 'Pi', modes: ['cli', 'tui'], enabled: false, source: 'setting', detected: false }],
      services: [],
      bootstraps: [],
      compatibility: {},
      effortLevels: {},
      effortLevelsByModel: {},
      presets: [],
    });

    await renderPage('/ai/harnesses');

    fireEvent.click(await screen.findByRole('button', { name: 'Install Pi Coding Agent CLI' }));
    const modal = await screen.findByTestId('runtime-install-modal');
    expect(modal).toHaveAttribute('data-runtime', 'pi');
    expect(modal).toHaveAttribute('data-stream-method', 'POST');
    expect(modal).toHaveAttribute('data-flush-ms', '250');
  });

  // An absolute path in `command` is a legitimate config — the widget must
  // still find its runtime rather than silently dropping the install button.
  it('matches a runtime through a path-qualified command', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'codex-pinned', name: 'Codex (pinned)', type: 'cli', command: '/opt/bin/codex', args: [], enabled: true }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({
      runtimes: { codex: { ...missingRuntime, id: 'codex', label: 'Codex CLI', command: 'codex' } },
    });

    await renderPage();

    expect(await screen.findByRole('button', { name: /Install Codex CLI/ })).toBeEnabled();
  });

  it('reports an installed runtime instead of offering another install', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-ollama', name: 'OpenCode Ollama', type: 'cli', command: 'opencode', args: ['run'], enabled: true }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: { ...missingRuntime, installed: true } } });

    await renderPage();

    expect(await screen.findByText(/installed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install OpenCode CLI/ })).not.toBeInTheDocument();
  });

  it('does not recommend disabling Grok codebase upload on the card or editor', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'grok-tui',
        name: 'Grok Build TUI',
        type: 'tui',
        command: 'grok',
        args: [],
        enabled: true,
        models: ['grok-configured-default'],
        defaultModel: 'grok-configured-default',
      }],
      activeProvider: 'grok-tui',
    });

    await renderPage();

    expect(await screen.findByText('Grok Build TUI')).toBeInTheDocument();
    expect(screen.queryByText(/uploads your entire working repo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/disable_codebase_upload/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('heading', { name: 'Edit Provider' })).toBeInTheDocument();
    expect(screen.queryByText(/uploads your entire working repo/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/disable_codebase_upload/i)).not.toBeInTheDocument();
  });

  it('explains why the install action is unavailable and links the vendor instructions', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-ollama', name: 'OpenCode Ollama', type: 'cli', command: 'opencode', args: ['run'], enabled: true }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({
      runtimes: {
        opencode: {
          ...missingRuntime,
          installable: false,
          blockedReason: "npm is not available on PortOS's PATH, so this host cannot install OpenCode CLI from this page.",
        },
      },
    });

    await renderPage();

    expect(await screen.findByText(/npm is not available on PortOS's PATH/)).toBeInTheDocument();
    // No dead Install button — the vendor's own instructions are the way out.
    expect(screen.queryByRole('button', { name: /Install OpenCode CLI/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Install instructions/ })).toHaveAttribute('href', 'https://opencode.ai/docs');
  });

  // Ollama / LM Studio keep their real installer on the Models → LLMs page, so the
  // provider card links there instead of streaming an install of its own — and
  // reads their state from the local-LLM status, which counts an installed app
  // with no CLI shim on PATH.
  it('links a locally-managed app to its own settings tab', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'lmstudio', name: 'LM Studio', type: 'api', endpoint: 'http://localhost:1234/v1', enabled: true }],
      activeProvider: null,
    });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: false } };

    await renderPage();

    expect(await screen.findByRole('link', { name: /Install LM Studio/ })).toHaveAttribute('href', '/models/llms');
  });

  // `null` means the local-LLM status has not answered yet — offering an
  // install from that state would flash a wrong CTA on every page load.
  it('offers nothing for a local app whose status has not been fetched', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'lmstudio', name: 'LM Studio', type: 'api', endpoint: 'http://localhost:1234/v1', enabled: true }],
      activeProvider: null,
    });

    await renderPage();

    expect(await screen.findByText('LM Studio')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Install LM Studio/ })).not.toBeInTheDocument();
  });

  it('shows no install widget for a command PortOS has no installer for', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'custom', name: 'Custom CLI', type: 'cli', command: 'my-agent', args: [], enabled: true }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: missingRuntime } });

    await renderPage();

    expect(await screen.findByText('Custom CLI')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Install/ })).not.toBeInTheDocument();
  });

  it('renders provider list when api.getProviders succeeds with data', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'p1', name: 'OpenAI', type: 'api', enabled: true, endpoint: 'https://api.openai.com', models: ['gpt-4'] }
      ],
      activeProvider: 'p1',
    });

    await renderPage();

    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
    expect(screen.queryByText('No presets configured')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();

    // Demoted to the overflow menu, but still a real anchor so it can be
    // opened in a new tab.
    await openHeaderMenu();
    expect(screen.getByRole('menuitem', { name: /Compare local models/ })).toHaveAttribute('href', '/models/performance');
  });

  it('uses the Models child navigation after Providers moves out of Settings', async () => {
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });

    await renderPage();

    const strip = await screen.findByRole('tablist', { name: 'Models sections' });
    expect(within(strip).getByRole('tab', { name: 'Providers', selected: true })).toBeInTheDocument();
  });

  // The page hosts ModelsTabsHeader; before #5653 it also hand-rolled a
  // `Settings` title bar above it, so every render stacked two h1s and pushed
  // the first provider card off a phone viewport.
  it('renders exactly one h1, naming the page rather than the settings section', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'p1', name: 'OpenAI', type: 'api', enabled: true, endpoint: 'https://api.openai.com', models: ['gpt-4'] }
      ],
      activeProvider: 'p1',
    });

    await renderPage();

    await screen.findByText('OpenAI');
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveAccessibleName('Providers');
  });

  it('shows a blank secret environment value as not set', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'bedrock',
        name: 'Bedrock CLI',
        type: 'cli',
        command: 'claude',
        enabled: true,
        envVars: { AWS_BEARER_TOKEN_BEDROCK: '' },
        secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'],
        missingPrerequisites: [],
      }],
      activeProvider: null,
    });

    await renderPage();

    expect(await screen.findByText('AWS_BEARER_TOKEN_BEDROCK=(not set)')).toBeInTheDocument();
    expect(screen.queryByText('AWS_BEARER_TOKEN_BEDROCK=***')).not.toBeInTheDocument();
  });

  it('renders EmptyState when api.getProviders succeeds with 0 items', async () => {
    api.getProviders.mockResolvedValue({
      providers: [],
      activeProvider: null,
    });

    await renderPage();

    expect(await screen.findByText('No presets configured')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
    // With nothing to group, no harness section renders either.
    expect(screen.queryByRole('button', { name: new RegExp('^Claude Code') })).not.toBeInTheDocument();
  });

  it('renders Banner with Retry button when api.getProviders rejects and does not show EmptyState', async () => {
    api.getProviders.mockRejectedValue(new Error('Network error'));

    await renderPage();

    expect(await screen.findByText('Failed to load AI providers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No presets configured')).not.toBeInTheDocument();
  });

  it('re-fetches when Retry button is clicked and displays providers upon success', async () => {
    api.getProviders
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        providers: [
          { id: 'p1', name: 'Claude', type: 'api', enabled: true, endpoint: 'https://api.anthropic.com', models: ['claude-3'] }
        ],
        activeProvider: 'p1',
      });

    await renderPage();

    const retryBtn = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);

    expect(await screen.findByText('Claude')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
    expect(screen.queryByText('No presets configured')).not.toBeInTheDocument();
    expect(api.getProviders).toHaveBeenCalledTimes(2);
  });
});

describe('handleAddSample error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getProviders.mockResolvedValue({
      providers: [],
      activeProvider: null,
    });
    api.getSampleProviders.mockResolvedValue({
      providers: [
        { id: 'sample-1', name: 'Sample AI', type: 'api', enabled: true, endpoint: 'https://api.sample.com', models: ['model-1'] }
      ]
    });
  });

  it.each([
    [400, { error: 'Invalid sample' }, 'Failed to add provider: Invalid sample'],
    [403, { code: 'HOST_CONTROL_FORBIDDEN', error: 'Connect as the operator' }, 'Connect as the operator'],
  ])('shows one toast and re-enables Add after HTTP %i', async (status, body, message) => {
    await renderPage();
    await clickLoadSamples();
    const addButton = await screen.findByRole('button', { name: 'Add' });

    await withFailedSampleRequest(status, body, async () => {
      await act(async () => { fireEvent.click(addButton); });

      expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'sample-1' }), { silent: true });
      expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(message);
    });
  });

  it('renders sample preset envVars using ProviderEnvVars with collapse affordance', async () => {
    const longVal = 'y'.repeat(120);
    api.getSampleProviders.mockResolvedValue({
      providers: [
        {
          id: 'sample-long-env',
          name: 'Sample Long Env',
          type: 'cli',
          command: 'opencode',
          enabled: true,
          models: ['model-1'],
          envVars: {
            OPENCODE_CONFIG_CONTENT: longVal,
          },
        },
      ],
    });

    await renderPage();
    await clickLoadSamples();

    expect(await screen.findByText('Sample Long Env')).toBeInTheDocument();
    expect(screen.getByText('Env:')).toBeInTheDocument();
    const expandBtn = screen.getByRole('button', { name: /expand opencode_config_content value/i });
    expect(expandBtn).toBeInTheDocument();
    fireEvent.click(expandBtn);
    expect(screen.getByRole('button', { name: /collapse opencode_config_content value/i })).toBeInTheDocument();
  });
});

describe('handleAddAllSamples error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getProviders.mockResolvedValue({
      providers: [],
      activeProvider: null,
    });
    api.getSampleProviders.mockResolvedValue({
      providers: [
        { id: 'sample-1', name: 'Sample AI 1', type: 'api', enabled: true, endpoint: 'https://api.sample1.com', models: ['model-1'] },
        { id: 'sample-2', name: 'Sample AI 2', type: 'api', enabled: true, endpoint: 'https://api.sample2.com', models: ['model-2'] },
        { id: 'sample-3', name: 'Sample AI 3', type: 'api', enabled: true, endpoint: 'https://api.sample3.com', models: ['model-3'] },
      ]
    });
  });

  it.each([
    [400, { error: 'Invalid sample' }, 3, 'Failed to add 3 providers'],
    [403, { code: 'HOST_CONTROL_FORBIDDEN', error: 'Connect as the operator' }, 1, 'Connect as the operator'],
  ])('shows one toast and keeps the samples after HTTP %i', async (status, body, attempts, message) => {
    await renderPage();
    await clickLoadSamples();
    const addAll = await screen.findByRole('button', { name: 'Add All (3)' });

    await withFailedSampleRequest(status, body, async () => {
      await act(async () => { fireEvent.click(addAll); });

      expect(api.createProvider).toHaveBeenCalledTimes(attempts);
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(message);
      expect(screen.getByRole('button', { name: 'Add All (3)' })).toBeEnabled();
    });
  });

  it('handles partial failure when adding all samples', async () => {
    api.createProvider
      .mockResolvedValueOnce({ id: 'sample-1' })
      .mockRejectedValueOnce(new Error('Creation failed'))
      .mockResolvedValueOnce({ id: 'sample-3' });

    await renderPage();

    await clickLoadSamples();

    const addAllBtn = await screen.findByRole('button', { name: 'Add All (3)' });
    fireEvent.click(addAllBtn);

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Added 2 providers, 1 failed'));
    expect(screen.getByText('Sample AI 2')).toBeInTheDocument();
    expect(screen.queryByText('Sample AI 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Sample AI 3')).not.toBeInTheDocument();
    expect(api.getProviders).toHaveBeenCalledTimes(2);
  });
});

describe('provider reasoning defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
  });

  it('shows the provider default-effort selector for an effort-capable provider', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'codex',
        name: 'Codex',
        type: 'cli',
        command: 'codex',
        executionOptionKeys: ['serviceTier'],
        enabled: true,
        models: ['gpt-5'],
        defaultModel: 'gpt-5',
        effort: '',
      }],
      activeProvider: 'codex',
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await act(async () => { await openEditorTab('Models'); });

    const effort = await screen.findByLabelText('Default Effort');
    expect(effort).toHaveValue('');
    fireEvent.change(effort, { target: { value: 'xhigh' } });
    expect(effort).toHaveValue('xhigh');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ effort: 'xhigh' }),
    ));
  });

  // `ollamaBacked` identifies the OpenCode-Ollama ladder but is NOT a form
  // field, so a capability shape built from formData alone dropped it — the
  // effort select never rendered, and any stored level was wiped on save.
  it('offers effort and thinking defaults on an Ollama-backed OpenCode provider', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-ollama',
        name: 'OpenCode Ollama',
        type: 'cli',
        command: 'opencode',
        args: ['run'],
        enabled: true,
        ollamaBacked: true,
        models: ['qwen3:32b'],
        defaultModel: 'qwen3:32b',
        effort: '',
        thinking: true,
        envVars: {},
      }],
      activeProvider: 'opencode-ollama',
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await openEditorTab('Models');

    const effort = await screen.findByLabelText('Default Effort');
    fireEvent.change(effort, { target: { value: 'high' } });

    await openEditorTab('Generation');
    const thinking = screen.getByLabelText('Thinking mode');
    expect(thinking).toHaveValue('true');
    fireEvent.change(thinking, { target: { value: 'false' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith(
      'opencode-ollama',
      expect.objectContaining({ effort: 'high', thinking: false }),
    ));
  });

  // The OpenCode llama TUI is the headline case: `llamaBacked` is a record
  // marker, not a form field, and the block used to be gated on the Ollama
  // check alone — so the provider that most needs a temperature had none.
  it('offers effort, temperature, top-p and thinking on a llama.cpp-backed OpenCode TUI', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-llama-tui',
        name: 'OpenCode llama TUI',
        type: 'tui',
        command: 'opencode',
        args: [],
        enabled: true,
        llamaBacked: true,
        models: ['qwen3.8-27b'],
        defaultModel: 'qwen3.8-27b',
        effort: '',
        thinking: true,
        envVars: {},
      }],
      activeProvider: 'opencode-llama-tui',
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await openEditorTab('Models');

    fireEvent.change(await screen.findByLabelText('Default Effort'), { target: { value: 'high' } });
    await openEditorTab('Generation');
    fireEvent.change(screen.getByLabelText('Temperature'), { target: { value: '0.2' } });
    fireEvent.change(screen.getByLabelText('Top-P'), { target: { value: '0.9' } });
    expect(screen.getByLabelText('Thinking mode')).toHaveValue('true');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith(
      'opencode-llama-tui',
      expect.objectContaining({ effort: 'high', temperature: 0.2, topP: 0.9, thinking: true }),
    ));
  });

  // The editor must be able to leave "unset" alone: seeding a default would let
  // an unrelated Save pin a temperature/thinking mode the backend never had, and
  // only Ollama has a documented server-side fallback to pin back to.
  it('saves an untouched llama.cpp provider without pinning any generation default', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-llama-tui',
        name: 'OpenCode llama TUI',
        type: 'tui',
        command: 'opencode',
        args: [],
        enabled: true,
        llamaBacked: true,
        models: ['qwen3.8-27b'],
        defaultModel: 'qwen3.8-27b',
        envVars: {},
      }],
      activeProvider: 'opencode-llama-tui',
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await openEditorTab('Generation');

    expect(await screen.findByLabelText('Temperature')).toHaveValue(null);
    expect(screen.getByLabelText('Thinking mode')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    expect(api.updateProvider.mock.calls[0][1]).toMatchObject({ temperature: null, topP: null, thinking: null });
  });

  // A Claude harness on Ollama is forwarded only MAX_THINKING_TOKENS
  // (server/lib/cliChildEnv.js) — it owns its own sampling, so offering a
  // temperature there would be a control that silently does nothing.
  it('offers only the thinking control on a Claude/Ollama provider', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'claude-ollama-tui',
        name: 'Claude Ollama TUI',
        type: 'tui',
        command: 'claude',
        args: [],
        enabled: true,
        ollamaBacked: true,
        models: ['qwen3:32b'],
        defaultModel: 'qwen3:32b',
        envVars: {},
      }],
      activeProvider: 'claude-ollama-tui',
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await openEditorTab('Generation');

    expect(await screen.findByLabelText('Thinking mode')).toBeInTheDocument();
    expect(screen.queryByLabelText('Temperature')).toBeNull();
    expect(screen.queryByLabelText('Top-P')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    const payload = api.updateProvider.mock.calls[0][1];
    expect(payload).not.toHaveProperty('temperature');
    expect(payload).not.toHaveProperty('topP');
  });

  // A stored default PortOS never forwards is a control that lies. The editor
  // hides the block for cloud providers, and the payload must not carry the
  // form's seeded values either (`topP: ''` isn't even a valid number).
  it('sends no generation defaults for a cloud API provider', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'anthropic',
        name: 'Anthropic',
        type: 'api',
        endpoint: 'https://api.anthropic.com/v1',
        enabled: true,
        models: ['claude-opus-5'],
        defaultModel: 'claude-opus-5',
        envVars: {},
      }],
      activeProvider: 'anthropic',
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await openEditorTab('Generation');

    expect(screen.queryByLabelText('Temperature')).toBeNull();
    expect(screen.queryByLabelText('Thinking mode')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    const payload = api.updateProvider.mock.calls[0][1];
    expect(payload).not.toHaveProperty('temperature');
    expect(payload).not.toHaveProperty('topP');
    expect(payload).not.toHaveProperty('thinking');
  });
});

describe('Codex subscription text read-risk gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'codex',
        name: 'Codex',
        type: 'cli',
        command: 'codex',
        enabled: true,
        textTransport: 'codex-app-server',
      }],
      activeProvider: 'codex',
    });
  });

  it('requires the read-risk acknowledgement before enabling generic text calls', async () => {
    await renderPage('/ai/presets/codex');

    const acknowledgement = await screen.findByLabelText(/Codex may read local files/i);
    const enable = screen.getByLabelText(/serve generic text calls/i);
    expect(acknowledgement).not.toBeChecked();
    expect(enable).toBeDisabled();

    fireEvent.click(acknowledgement);
    expect(enable).toBeEnabled();
    fireEvent.click(enable);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        textTransportEnabled: true,
        textTransportReadRiskAcknowledged: true,
      }),
    ));
  });

  it('turns the transport back off when the acknowledgement is withdrawn', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'codex',
        name: 'Codex',
        type: 'cli',
        command: 'codex',
        enabled: true,
        textTransport: 'codex-app-server',
        textTransportEnabled: true,
        textTransportReadRiskAcknowledged: true,
      }],
      activeProvider: 'codex',
    });
    await renderPage('/ai/presets/codex');

    const acknowledgement = await screen.findByLabelText(/Codex may read local files/i);
    const enable = screen.getByLabelText(/serve generic text calls/i);
    expect(enable).toBeChecked();
    fireEvent.click(acknowledgement);
    expect(enable).not.toBeChecked();
    expect(enable).toBeDisabled();
  });
});

describe('provider editor deep links', () => {
  const provider = {
    id: 'codex',
    name: 'Codex',
    type: 'cli',
    command: 'codex',
    enabled: true,
    models: ['gpt-5'],
    defaultModel: 'gpt-5',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getProviders.mockResolvedValue({ providers: [provider], activeProvider: 'codex' });
  });

  it('opens the editor for the provider named in the URL', async () => {
    await renderPage('/ai/presets/codex');

    expect(await screen.findByRole('heading', { name: 'Edit Provider' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Codex')).toBeInTheDocument();
  });

  it('opens the create form on /ai/new', async () => {
    await renderPage('/ai/presets/new');

    expect(await screen.findByRole('heading', { name: 'Add Provider' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  // A deleted/hand-edited id must bounce back to the list rather than leaving a
  // blank editor open over it.
  it('sends an unknown provider id back to the list', async () => {
    await renderPage('/ai/presets/does-not-exist');

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No provider with id "does-not-exist"'));
    expect(screen.queryByRole('heading', { name: 'Edit Provider' })).toBeNull();
  });

  // The id comes off the URL, so a prototype key must not resolve to
  // Object.prototype and open the editor on it.
  it('does not open the editor for a prototype-chain id', async () => {
    await renderPage('/ai/presets/__proto__');

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No provider with id "__proto__"'));
    expect(screen.queryByRole('heading', { name: 'Edit Provider' })).toBeNull();
  });

  it('honors the ?providerTab deep link', async () => {
    await renderPage('/ai/presets/codex?providerTab=models');

    expect(await screen.findByLabelText('Default Model')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  });

  // Only the active tab renders, so the browser can't run its own required-field
  // check for a Save triggered from another tab.
  it('sends the user back to the field a cross-tab Save left empty', async () => {
    await renderPage('/ai/presets/codex');

    fireEvent.change(await screen.findByDisplayValue('Codex'), { target: { value: '  ' } });
    await openEditorTab('Models');
    await screen.findByLabelText('Default Model');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Name is required'));
    expect(api.updateProvider).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Connection' })).toHaveAttribute('aria-selected', 'true');
  });

  // A provider whose display name slugifies to `new` must still be editable —
  // the create route would shadow it if the edit id sat directly under /ai.
  it('edits a provider whose id collides with the create route', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ ...provider, id: 'new', name: 'New' }],
      activeProvider: 'new',
    });

    await renderPage('/ai/edit/new');

    expect(await screen.findByRole('heading', { name: 'Edit Provider' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('New')).toBeInTheDocument();
  });

  // The inputs' own `min`/`max`/`type="url"` only run for the mounted tab, so
  // the submit path restates them and points at the tab that owns the field.
  it.each([
    ['an unparseable endpoint', { type: 'api', endpoint: 'not-a-url', command: '' }, 'Endpoint must be a full URL, e.g. http://localhost:1234/v1', 'Connection'],
    ['an out-of-range planning window', { contextWindow: 1 }, 'Planning Window must be between 512 and 2,097,152 tokens', 'Generation'],
  ])('blocks a cross-tab Save with %s', async (_label, patch, message, tab) => {
    api.getProviders.mockResolvedValue({
      providers: [{ ...provider, ...patch }],
      activeProvider: 'codex',
    });

    await renderPage('/ai/presets/codex?providerTab=models');

    await screen.findByLabelText('Default Model');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(api.updateProvider).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes back to the list', async () => {
    await renderPage('/ai/presets/codex');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Edit Provider' })).toBeNull());
  });
});

describe('Local num_ctx field', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
  });

  const openEditorFor = async (provider) => {
    api.getProviders.mockResolvedValue({ providers: [provider], activeProvider: provider.id });
    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  };

  // An Ollama-backed TUI reaches the daemon itself, so num_ctx is the ONLY way
  // to lift it off Ollama's VRAM-based auto-pick. It used to be `api`-only.
  it('offers num_ctx on an Ollama-backed TUI provider and saves it', async () => {
    await openEditorFor({
      id: 'claude-ollama-tui',
      name: 'Claude Ollama TUI',
      type: 'tui',
      command: 'claude',
      enabled: true,
      ollamaBacked: true,
      models: [],
      envVars: {},
    });

    await openEditorTab('Generation');

    const numCtx = await screen.findByLabelText('Local num_ctx');
    fireEvent.change(numCtx, { target: { value: '131072' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith(
      'claude-ollama-tui',
      expect.objectContaining({ numCtx: 131072 }),
    ));
  });

  it('hides num_ctx on a cloud CLI provider, which has no Ollama daemon to reload', async () => {
    await openEditorFor({
      id: 'codex',
      name: 'Codex',
      type: 'cli',
      command: 'codex',
      enabled: true,
      models: ['gpt-5'],
      defaultModel: 'gpt-5',
    });

    await openEditorTab('Generation');

    await screen.findByLabelText('Planning Window');
    expect(screen.queryByLabelText('Local num_ctx')).toBeNull();
   });
});

describe('OpenCode OrcaRouter key hint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
   });

  // The OpenCode wrapper carries no key of its own — the card must point the
  // user at the sibling `orcarouter` API provider, not a key field that's absent.
  it('points a keyless OpenCode wrapper at the sibling OrcaRouter API key', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        {
         id: 'opencode-orcarouter',
         name: 'OpenCode OrcaRouter',
         type: 'cli',
         command: 'opencode',
         enabled: true,
         orcarouterBacked: true,
         models: ['orcarouter/auto'],
         defaultModel: 'orcarouter/auto',
        },
        { id: 'orcarouter', name: 'OrcaRouter', type: 'api', enabled: false, hasApiKey: false },
       ],
      activeProvider: 'opencode-orcarouter',
     });

    await renderPage();

    const hint = await screen.findByText(/API key is inherited from/);
    expect(hint).toBeInTheDocument();
    expect(screen.getByText(/OrcaRouter key: not set/)).toBeInTheDocument();
   });

  it('opens the sibling API provider so the user can paste the OrcaRouter key', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        {
          id: 'opencode-orcarouter',
          name: 'OpenCode OrcaRouter',
          type: 'cli',
          command: 'opencode',
          enabled: true,
          orcarouterBacked: true,
          models: ['orcarouter/auto'],
          defaultModel: 'orcarouter/auto',
        },
        { id: 'orcarouter', name: 'OrcaRouter', type: 'api', enabled: false, endpoint: 'https://api.orcarouter.ai/v1', hasApiKey: false },
      ],
      activeProvider: 'opencode-orcarouter',
    });

    await renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit OrcaRouter API provider' }));

    expect(await screen.findByRole('heading', { name: 'Edit Provider' })).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByText(/ORCAROUTER_API_KEY/)).toBeInTheDocument();
  });

  it('collapses to a one-line confirmation when the sibling API provider has the key', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        {
         id: 'opencode-orcarouter-tui',
         name: 'OpenCode OrcaRouter TUI',
         type: 'tui',
         command: 'opencode',
         enabled: true,
         orcarouterBacked: true,
         models: ['orcarouter/auto'],
         defaultModel: 'orcarouter/auto',
        },
        { id: 'orcarouter', name: 'OrcaRouter', type: 'api', enabled: false, hasApiKey: true },
       ],
      activeProvider: 'opencode-orcarouter-tui',
     });

    await renderPage();

    // Configured providers state the fact and keep the link; the "where does
    // the key go?" explanation is only shown while it is still unanswered.
    expect(await screen.findByText('OrcaRouter API key configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit OrcaRouter API provider' })).toBeInTheDocument();
    expect(screen.queryByText(/API key is inherited from/)).not.toBeInTheDocument();
   });

  // A non-orcarouter-backed provider must never see the inheritance hint.
  it('does not show the hint for a non-orcarouter-backed provider', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'orca', name: 'My Orca', type: 'cli', command: 'claude', enabled: true, models: [] },
       ],
      activeProvider: 'orca',
     });

    await renderPage();

    expect(await screen.findByText('My Orca')).toBeInTheDocument();
    expect(screen.queryByText(/API key is inherited from/)).not.toBeInTheDocument();
   });
});

describe('AIProviders Run Prompt and orchestration settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.createRun.mockResolvedValue({ runId: 'run-123' });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  });

  it('renders orchestration profiles link in the more actions menu', async () => {
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
    await renderPage();

    await openHeaderMenu();
    const link = await screen.findByRole('menuitem', { name: 'Orchestration profiles' });
    expect(link).toHaveAttribute('href', '/settings/orchestration');
  });

  it('runs a prompt directly on the selected provider', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'prov-1', name: 'Prov 1', type: 'api', enabled: true, hardwareUnavailable: false }],
      activeProvider: 'prov-1',
    });
    await renderPage();

    const runBtn = await screen.findByRole('button', { name: 'Run Prompt' });
    fireEvent.click(runBtn);

    const promptInput = await screen.findByLabelText('Prompt');
    expect(screen.queryByLabelText('Orchestration profile')).not.toBeInTheDocument();
    fireEvent.change(promptInput, { target: { value: 'Test direct run' } });

    const executeBtn = screen.getByRole('button', { name: 'Execute' });
    fireEvent.click(executeBtn);

    await waitFor(() => {
      expect(api.createRun.mock.calls).toStrictEqual([[
        {
          providerId: 'prov-1',
          prompt: 'Test direct run',
          workspacePath: undefined,
          workspaceName: undefined,
        },
        { silent: true },
      ]]);
    });
  });
});

describe('AIProviders list resources (#12171)', () => {
  it('shows error row with Retry when workspaces fail to load, and recovers on retry', async () => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({ providers: [{ id: 'p1', name: 'P1', type: 'api', enabled: true }], activeProvider: 'p1' });
    api.getApps.mockRejectedValueOnce(new Error('apps offline'));
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Run Prompt' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load workspaces — apps offline');

    api.getApps.mockResolvedValueOnce([{ id: 'app-1', name: 'App 1', repoPath: '/path' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const workspaceSelect = await screen.findByLabelText('Workspace');
    expect(workspaceSelect).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows empty option when workspaces list is empty', async () => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({ providers: [{ id: 'p1', name: 'P1', type: 'api', enabled: true }], activeProvider: 'p1' });
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });

    await renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Run Prompt' }));

    const workspaceSelect = await screen.findByLabelText('Workspace');
    expect(within(workspaceSelect).getByRole('option', { name: 'No workspaces found' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows error row with Retry when fleet peers fail to load in fleet setup', async () => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getInstances.mockRejectedValueOnce(new Error('tailnet unreachable'));

    mountPage('/ai/fleet?fleetStep=client');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load fleet peers — tailnet unreachable');

    api.getInstances.mockResolvedValueOnce({ peers: [{ id: 'peer-1', name: 'Peer 1', host: 'host.ts.net', enabled: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(await screen.findByLabelText('Known PortOS peer')).toBeInTheDocument();
  });

  it('shows error row with Retry when sample providers fail to load, not "all samples already added"', async () => {
    vi.clearAllMocks();
    api.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    api.getSampleProviders.mockRejectedValueOnce(new Error('samples offline'));

    await renderPage();
    await clickLoadSamples();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sample providers — samples offline');
    expect(screen.queryByText(/All sample providers are already in your configuration/)).not.toBeInTheDocument();

    api.getSampleProviders.mockResolvedValueOnce({
      providers: [{ id: 'sample-1', name: 'Sample AI', type: 'api', enabled: true, endpoint: 'https://api.example.com', models: ['m1'] }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Sample AI')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
