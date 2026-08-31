import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({
  getProviders: vi.fn(),
  getApps: vi.fn(),
  getProviderStatuses: vi.fn(),
  getProviderRuntimes: vi.fn(),
  getProviderReadiness: vi.fn(),
  getSampleProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
}));

const localModels = vi.hoisted(() => ({ value: { ctxById: {}, installed: { ollama: null, lmstudio: null } } }));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({
  default: toast,
}));
vi.mock('../services/socket', () => ({
  default: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));
vi.mock('../hooks/useLocalModels', () => ({
  default: () => localModels.value,
}));
vi.mock('../components/settings/SettingsTabsHeader', () => ({
  default: () => <div data-testid="settings-tabs-header" />,
}));
vi.mock('../components/install/RuntimeInstallModal', () => ({
  // `params` becomes the setup request's query string, so the test can assert
  // WHICH setup step the clicked button asked for.
  default: ({ open, runtime, streamMethod, flushMs, params }) => open
    ? <div data-testid="runtime-install-modal" data-runtime={runtime} data-stream-method={streamMethod} data-flush-ms={flushMs} data-params={JSON.stringify(params || {})} />
    : null,
}));

import AIProviders, { PROVIDER_SECTIONS } from './AIProviders';
import { CARD_STATE_STYLES } from '../components/providers/ProviderCard';
import { PROVIDER_CARD_STATE } from '../utils/providers';

// The editor is route-driven (/ai/new · /ai/edit/:providerId over the same
// page), so the tests mount the real route table rather than a bare page —
// clicking Edit navigates, and a deep link can be rendered directly.
const renderPage = (initialPath = '/ai') => render(
  <MemoryRouter initialEntries={[initialPath]}>
    <Routes>
      <Route path="/ai" element={<AIProviders />} />
      <Route path="/ai/new" element={<AIProviders />} />
      <Route path="/ai/edit/:providerId" element={<AIProviders />} />
    </Routes>
  </MemoryRouter>
);

// The editor opens on the Connection tab; every other field lives behind a tab
// switch (the drawer renders only the active panel).
const openEditorTab = async (label) => {
  fireEvent.click(await screen.findByRole('tab', { name: label }));
};

// One entry of the `runtimes` map from GET /api/providers/runtimes.
const missingRuntime = {
  id: 'opencode',
  label: 'OpenCode CLI',
  command: 'opencode',
  installed: false,
  method: 'npm',
  installable: true,
  blockedReason: null,
  docsUrl: 'https://opencode.ai/docs',
};

describe('AIProviders page load error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  });

  it('offers an install button on the card of a provider whose CLI is missing', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-ollama', name: 'OpenCode Ollama', type: 'cli', command: 'opencode', args: ['run'], enabled: true }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: missingRuntime } });

    renderPage();

    const install = await screen.findByRole('button', { name: /Install OpenCode CLI/ });
    expect(install).toBeEnabled();
    fireEvent.click(install);
    const modal = screen.getByTestId('runtime-install-modal');
    expect(modal).toHaveAttribute('data-runtime', 'opencode');
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

    renderPage();

    expect(await screen.findByRole('button', { name: /Install Codex CLI/ })).toBeEnabled();
  });

  it('reports an installed runtime instead of offering another install', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-ollama', name: 'OpenCode Ollama', type: 'cli', command: 'opencode', args: ['run'], enabled: true }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: { ...missingRuntime, installed: true } } });

    renderPage();

    expect(await screen.findByText(/installed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install OpenCode CLI/ })).not.toBeInTheDocument();
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

    renderPage();

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

    renderPage();

    expect(await screen.findByRole('link', { name: /Install LM Studio/ })).toHaveAttribute('href', '/models/llms');
  });

  // `null` means the local-LLM status has not answered yet — offering an
  // install from that state would flash a wrong CTA on every page load.
  it('offers nothing for a local app whose status has not been fetched', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'lmstudio', name: 'LM Studio', type: 'api', endpoint: 'http://localhost:1234/v1', enabled: true }],
      activeProvider: null,
    });

    renderPage();

    expect(await screen.findByText('LM Studio')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Install LM Studio/ })).not.toBeInTheDocument();
  });

  it('shows no install widget for a command PortOS has no installer for', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'custom', name: 'Custom CLI', type: 'cli', command: 'my-agent', args: [], enabled: true }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: missingRuntime } });

    renderPage();

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

    renderPage();

    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Compare local models/ })).toHaveAttribute('href', '/models/performance');
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
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

    renderPage();

    expect(await screen.findByText('AWS_BEARER_TOKEN_BEDROCK=(not set)')).toBeInTheDocument();
    expect(screen.queryByText('AWS_BEARER_TOKEN_BEDROCK=***')).not.toBeInTheDocument();
  });

  it('renders EmptyState when api.getProviders succeeds with 0 items', async () => {
    api.getProviders.mockResolvedValue({
      providers: [],
      activeProvider: null,
    });

    renderPage();

    expect(await screen.findByText('No providers configured')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
    // With nothing to group, no readiness section renders either.
    expect(screen.queryByRole('button', { name: new RegExp('^Enabled') })).not.toBeInTheDocument();
  });

  it('renders Banner with Retry button when api.getProviders rejects and does not show EmptyState', async () => {
    api.getProviders.mockRejectedValue(new Error('Network error'));

    renderPage();

    expect(await screen.findByText('Failed to load AI providers')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
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

    renderPage();

    const retryBtn = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);

    expect(await screen.findByText('Claude')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load AI providers')).not.toBeInTheDocument();
    expect(screen.queryByText('No providers configured')).not.toBeInTheDocument();
    expect(api.getProviders).toHaveBeenCalledTimes(2);
  });
});

describe('local-daemon readiness on the provider card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-llama-tui', name: 'OpenCode llama TUI', type: 'tui', command: 'opencode', args: [], enabled: true, endpoint: 'http://127.0.0.1:5568/v1', llamaBacked: true }],
      activeProvider: null,
    });
  });

  it('surfaces the unmet requirements when the local daemon is not running', async () => {
    api.getProviderReadiness.mockResolvedValue({
      readiness: {
        'opencode-llama-tui': {
          kind: 'llama',
          label: 'llama.cpp',
          endpoint: 'http://127.0.0.1:5568/v1',
          manageUrl: '/models/llms',
          docsUrl: 'https://example.com/docs',
          ready: false,
          checks: [
            { id: 'runtime', label: 'llama.cpp installed', ok: false, detail: 'not found', fixHint: 'Install llama.cpp from Models → LLMs.' },
            { id: 'server', label: 'llama.cpp server responding', ok: false, detail: 'nothing answered', fixHint: 'Install llama.cpp first, then start it.' },
          ],
        },
      },
    });

    renderPage();

    expect(await screen.findByText(/llama\.cpp setup incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/Install llama\.cpp from Models/)).toBeInTheDocument();
    expect(screen.queryByText(/setup docs/i)).not.toBeInTheDocument();
  });

  it('sends the weights-download action when the checklist offers it', async () => {
    // MTPLX installed, nothing cached: the button is the download, and the
    // action has to reach the setup request — sending the default would run a
    // plain start, which is the failure this whole path exists to avoid.
    api.getProviderReadiness.mockResolvedValue({
      readiness: {
        'opencode-llama-tui': {
          kind: 'mtplx',
          label: 'MTPLX',
          endpoint: 'http://127.0.0.1:8000/v1',
          manageUrl: null,
          ready: false,
          setup: { runtime: 'mtplx', label: 'MTPLX', action: 'pull-start', actionLabel: 'Download the default model & start MTPLX', blockedReason: null },
          checks: [
            { id: 'runtime', label: 'MTPLX installed', ok: true, detail: 'on PATH', fixHint: null },
            { id: 'server', label: 'MTPLX server responding', ok: false, detail: 'MTPLX has no model weights cached, so its server exits before it binds a port.', fixHint: 'Use “Download the default model & start MTPLX” below — PortOS does this for you.' },
          ],
        },
      },
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Download the default model & start MTPLX/ }));
    const modal = await screen.findByTestId('runtime-install-modal');
    expect(JSON.parse(modal.getAttribute('data-params'))).toEqual({ provider: 'opencode-llama-tui', action: 'pull-start' });
    expect(modal.getAttribute('data-runtime')).toBe('mtplx');
  });

  it('lets the user match this provider to the model llama.cpp is actually serving', async () => {
    api.updateProvider.mockResolvedValue({ id: 'opencode-llama-tui', defaultModel: 'dflash' });
    api.getProviderReadiness.mockResolvedValue({
      readiness: {
        'opencode-llama-tui': {
          kind: 'llama',
          label: 'llama.cpp',
          endpoint: 'http://127.0.0.1:5568/v1',
          manageUrl: '/models/llms',
          ready: false,
          checks: [
            { id: 'runtime', label: 'llama.cpp installed', ok: true, detail: 'on PATH', fixHint: null },
            { id: 'server', label: 'llama.cpp server responding', ok: true, detail: 'answered', fixHint: null },
            {
              id: 'model',
              label: 'Model `qwen3.8-27b-dflash2` available',
              ok: false,
              detail: 'llama.cpp is serving `dflash`.',
              fixHint: 'This provider will send `qwen3.8-27b-dflash2`, but the running server only accepts `dflash`.',
              servedModels: ['dflash'],
            },
          ],
        },
      },
    });
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-llama-tui',
        name: 'OpenCode llama TUI',
        type: 'tui',
        command: 'opencode',
        args: [],
        enabled: true,
        endpoint: 'http://127.0.0.1:5568/v1',
        llamaBacked: true,
        models: ['dflash', 'qwen3.8-27b-dflash2'],
        defaultModel: 'qwen3.8-27b-dflash2',
      }],
      activeProvider: null,
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Use dflash as default/ }));
    await waitFor(() => {
      expect(api.updateProvider).toHaveBeenCalledWith('opencode-llama-tui', { defaultModel: 'dflash' });
    });
  });

  it('renders no checklist for a provider the server reports nothing about', async () => {
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });

    renderPage();

    expect(await screen.findByText('OpenCode llama TUI')).toBeInTheDocument();
    expect(screen.queryByText(/setup incomplete/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ready$/)).not.toBeInTheDocument();
  });
});

describe('an API provider pointed at another machine', () => {
  // `localBackendForProvider` matches by NAME and port, so a provider named
  // "LM Studio <peer>" resolved to the `lmstudio` backend and collected THIS
  // host's install state — a card badged READY carried "LM Studio not
  // installed / Install LM Studio" for a server running on someone else's box.
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    // LM Studio is genuinely absent from THIS machine.
    localModels.value = { ctxById: {}, installed: { ollama: false, lmstudio: false } };
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'lmstudio-peer',
        name: 'LM Studio peer',
        type: 'api',
        enabled: true,
        endpoint: 'http://192.168.1.50:1234/v1',
        models: ['qwen/qwen3.5-35b-a3b'],
        defaultModel: 'qwen/qwen3.5-35b-a3b',
      }],
      activeProvider: null,
    });
  });

  it('offers no local install for it, and does not demand an API key', async () => {
    renderPage();

    expect(await screen.findByText('LM Studio peer')).toBeInTheDocument();
    expect(screen.queryByText(/LM Studio not installed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Install LM Studio/)).not.toBeInTheDocument();
    // A keyless call to a private-network endpoint is a supported setup, so the
    // card must not contradict the READY badge it is wearing.
    expect(screen.getByText(/none \(private network endpoint\)/)).toBeInTheDocument();
    expect(screen.queryByText(/not set — Edit this provider/)).not.toBeInTheDocument();
  });

  it('still offers the local install for the same backend on THIS machine', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'lmstudio',
        name: 'LM Studio',
        type: 'api',
        enabled: true,
        endpoint: 'http://localhost:1234/v1',
        models: [],
      }],
      activeProvider: null,
    });

    renderPage();

    expect(await screen.findByText(/LM Studio not installed/)).toBeInTheDocument();
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

  it('resets addingSample state and re-enables button if api.createProvider rejects', async () => {
    api.createProvider.mockRejectedValue(new Error('Failed to create provider'));

    renderPage();

    const loadSamplesBtn = await screen.findByRole('button', { name: 'Load Samples' });
    fireEvent.click(loadSamplesBtn);

    const addBtn = await screen.findByRole('button', { name: 'Add' });
    fireEvent.click(addBtn);

    expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'sample-1' }));

    const reEnabledAddBtn = await screen.findByRole('button', { name: 'Add' });
    expect(reEnabledAddBtn).not.toBeDisabled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Failed to add provider: Failed to create provider'));
  });
});

describe('handleAddAllSamples partial failure handling', () => {
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

  it('handles partial failure when adding all samples', async () => {
    api.createProvider
      .mockResolvedValueOnce({ id: 'sample-1' })
      .mockRejectedValueOnce(new Error('Creation failed'))
      .mockResolvedValueOnce({ id: 'sample-3' });

    renderPage();

    const loadSamplesBtn = await screen.findByRole('button', { name: 'Load Samples' });
    fireEvent.click(loadSamplesBtn);

    const addAllBtn = await screen.findByRole('button', { name: 'Add All (3)' });
    fireEvent.click(addAllBtn);

    expect(await screen.findByText('Sample AI 2')).toBeInTheDocument();
    expect(screen.queryByText('Sample AI 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Sample AI 3')).not.toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalledWith('Added 2 providers, 1 failed');
    expect(api.getProviders).toHaveBeenCalledTimes(2);
  });
});

describe('CoS Agent Runner allowlist warning', () => {
  const cliProvider = (command) => ({
    id: 'p1', name: 'Custom Agent', type: 'cli', enabled: true, command, args: [],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
  });

  it('badges a provider whose command is off the published allowlist', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('my-custom-agent')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    renderPage();

    expect(await screen.findByText('NO AGENT RUNNER')).toBeInTheDocument();
  });

  it('does not badge a provider whose command IS on the allowlist', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('/usr/local/bin/claude')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    renderPage();

    expect(await screen.findByText('Custom Agent')).toBeInTheDocument();
    expect(screen.queryByText('NO AGENT RUNNER')).not.toBeInTheDocument();
  });

  // A server that predates #4143 omits `runnerAllowedCommands`; an unfetchable
  // list must read as "can't tell", never as "nothing is allowed".
  it('stays silent when the server omits runnerAllowedCommands', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('my-custom-agent')],
      activeProvider: 'p1',
    });

    renderPage();

    expect(await screen.findByText('Custom Agent')).toBeInTheDocument();
    expect(screen.queryByText('NO AGENT RUNNER')).not.toBeInTheDocument();
  });

  it('warns inline in the editor as the command is typed, without blocking Save', async () => {
    api.getProviders.mockResolvedValue({
      providers: [cliProvider('claude')],
      activeProvider: 'p1',
      runnerAllowedCommands: ['claude', 'codex'],
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    const commandInput = await screen.findByDisplayValue('claude');
    expect(screen.queryByText(/command allowlist/)).not.toBeInTheDocument();

    fireEvent.change(commandInput, { target: { value: 'my-custom-agent' } });

    expect(await screen.findByText(/command allowlist/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
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
        enabled: true,
        models: ['gpt-5'],
        defaultModel: 'gpt-5',
        effort: '',
      }],
      activeProvider: 'codex',
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await openEditorTab('Models');

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

    renderPage();

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

    renderPage();

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

    renderPage();

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

    renderPage();

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

    renderPage();

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
    renderPage('/ai/edit/codex');

    expect(await screen.findByRole('heading', { name: 'Edit Provider' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('Codex')).toBeInTheDocument();
  });

  it('opens the create form on /ai/new', async () => {
    renderPage('/ai/new');

    expect(await screen.findByRole('heading', { name: 'Add Provider' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  // A deleted/hand-edited id must bounce back to the list rather than leaving a
  // blank editor open over it.
  it('sends an unknown provider id back to the list', async () => {
    renderPage('/ai/edit/does-not-exist');

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No provider with id "does-not-exist"'));
    expect(screen.queryByRole('heading', { name: 'Edit Provider' })).toBeNull();
  });

  // The id comes off the URL, so a prototype key must not resolve to
  // Object.prototype and open the editor on it.
  it('does not open the editor for a prototype-chain id', async () => {
    renderPage('/ai/edit/__proto__');

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No provider with id "__proto__"'));
    expect(screen.queryByRole('heading', { name: 'Edit Provider' })).toBeNull();
  });

  it('honors the ?providerTab deep link', async () => {
    renderPage('/ai/edit/codex?providerTab=models');

    expect(await screen.findByLabelText('Default Model')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
  });

  // Only the active tab renders, so the browser can't run its own required-field
  // check for a Save triggered from another tab.
  it('sends the user back to the field a cross-tab Save left empty', async () => {
    renderPage('/ai/edit/codex');

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

    renderPage('/ai/edit/new');

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

    renderPage('/ai/edit/codex?providerTab=models');

    await screen.findByLabelText('Default Model');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(message));
    expect(api.updateProvider).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes back to the list', async () => {
    renderPage('/ai/edit/codex');

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
    renderPage();
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

    renderPage();

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

    renderPage();

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

    renderPage();

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

    renderPage();

    expect(await screen.findByText('My Orca')).toBeInTheDocument();
    expect(screen.queryByText(/API key is inherited from/)).not.toBeInTheDocument();
   });
});

describe('readiness grouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  });

  it('sorts each provider into the section its readiness implies', async () => {
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'ready', name: 'Ready CLI', type: 'cli', command: 'claude', enabled: true },
        { id: 'off', name: 'Switched Off', type: 'cli', command: 'claude', enabled: false },
        { id: 'keyless', name: 'Keyless Cloud', type: 'api', endpoint: 'https://api.example.com/v1', hasApiKey: false, enabled: true },
      ],
      activeProvider: 'ready',
    });

    renderPage();

    expect(await screen.findByRole('button', { name: new RegExp('^Enabled') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp('^Needs setup') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp('^Disabled') })).toBeInTheDocument();
    expect(screen.getByText('READY')).toBeInTheDocument();
    expect(screen.getByText('DISABLED')).toBeInTheDocument();
    expect(screen.getByText('NEEDS SETUP')).toBeInTheDocument();
    // The blocker itself stays where its fix is — the card's API-key row.
    expect(screen.getByText(/not set — Edit this provider to paste one/)).toBeInTheDocument();
  });

  // A missing CLI is what stops the provider — not the toggle — so it belongs in
  // "Needs setup" whichever way the switch sits.
  it('files a switched-off provider with a missing CLI under Needs setup', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'opencode-ollama', name: 'OpenCode Ollama', type: 'cli', command: 'opencode', enabled: false }],
      activeProvider: null,
    });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: { opencode: missingRuntime } });

    renderPage();

    expect(await screen.findByText('NEEDS SETUP')).toBeInTheDocument();
    expect(screen.getByText('OpenCode CLI not installed')).toBeInTheDocument();
    expect(screen.getByText('SWITCHED OFF')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp('^Disabled') })).not.toBeInTheDocument();
  });

  // The provider list is authoritative: no sibling means the wrapper has no key
  // to inherit at spawn time, which is a missing prerequisite, not "unknown".
  it('files an OrcaRouter wrapper whose sibling was deleted under Needs setup', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-orcarouter',
        name: 'OpenCode OrcaRouter',
        type: 'cli',
        command: 'opencode',
        enabled: true,
        orcarouterBacked: true,
      }],
      activeProvider: null,
    });

    renderPage();

    expect(await screen.findByText('NEEDS SETUP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp('^Needs setup') })).toBeInTheDocument();
  });

  it('badges an enabled-but-benched provider with its reason', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'claude', name: 'Claude', type: 'cli', command: 'claude', enabled: true }],
      activeProvider: 'claude',
    });
    api.getProviderStatuses.mockResolvedValue({
      providers: { claude: { available: false, reason: 'usage-limit', message: 'Usage limit reached' } },
    });

    renderPage();

    expect(await screen.findByText('BENCHED · usage-limit')).toBeInTheDocument();
    // Benched providers stay in the Enabled group — nothing is missing on them.
    expect(screen.getByRole('button', { name: new RegExp('^Enabled') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp('^Needs setup') })).not.toBeInTheDocument();
  });

  it('folds a section away when its header is clicked', async () => {
    api.getProviders.mockResolvedValue({
      providers: [{ id: 'off', name: 'Switched Off', type: 'cli', command: 'claude', enabled: false }],
      activeProvider: null,
    });

    renderPage();

    const header = await screen.findByRole('button', { name: /Disabled/ });
    expect(screen.getByText('Switched Off')).toBeInTheDocument();

    fireEvent.click(header);
    expect(screen.queryByText('Switched Off')).not.toBeInTheDocument();
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(header);
    expect(screen.getByText('Switched Off')).toBeInTheDocument();
  });
});

// Both tables are keyed off PROVIDER_CARD_STATE, and a state missing from either
// fails quietly: no PROVIDER_SECTIONS row and those cards vanish from the page,
// no CARD_STATE_STYLES row and the card throws on `style.border`.
describe('readiness table coverage', () => {
  it('gives every readiness state a card style and exactly one section', () => {
    for (const state of Object.values(PROVIDER_CARD_STATE)) {
      expect(CARD_STATE_STYLES[state]).toBeDefined();
      expect(PROVIDER_SECTIONS.filter(section => section.states.includes(state))).toHaveLength(1);
    }
  });
});

describe('Launch in Shell button on TUI provider cards', () => {
  // The card hands the user a one-click way to drive a TUI provider by hand.
  // The link carries only the provider ID — the server pairs the command with
  // the provider's env (its backend/auth) when it spawns the PTY, and those
  // values are secret, so the command line itself must NOT be what's sent.
  // `tuiCommandLine` is the display half: it decides whether the button renders
  // at all (an older server omits it) and shows what will run.
  const baseMocks = () => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  };

  it('links to the Shell page with the server-built command line', async () => {
    baseMocks();
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'codex',
        name: 'Codex TUI',
        type: 'tui',
        command: 'codex',
        args: [],
        enabled: true,
        tuiCommandLine: 'codex --dangerously-bypass-approvals-and-sandbox --model gpt-5',
      }],
      activeProvider: null,
    });

    renderPage();

    const link = await screen.findByRole('link', { name: /Launch in Shell/ });
    // By ID, never by command — sending the line would leave the provider's env
    // behind and launch it against the wrong backend.
    expect(link).toHaveAttribute('href', '/shell?provider=codex');
    expect(link.getAttribute('href')).not.toContain('cmd=');
    // The resolved line is still surfaced, so the user can see what will run.
    expect(link).toHaveAttribute('title', expect.stringContaining('--model gpt-5'));
  });

  it('renders no button for a CLI provider, or when the server sent no command line', async () => {
    baseMocks();
    api.getProviders.mockResolvedValue({
      providers: [
        { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', args: [], enabled: true },
        { id: 'legacy-tui', name: 'Legacy TUI', type: 'tui', command: 'claude', args: [], enabled: true },
      ],
      activeProvider: null,
    });

    renderPage();

    expect(await screen.findByText('Legacy TUI')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Launch in Shell/ })).not.toBeInTheDocument();
  });
});

describe('provider card layout', () => {
  // The card's details used to be the FIRST flex item of the same row that
  // holds the action buttons. The button group never shrinks below its
  // max-content width (seven buttons ≈ 660px), so on a real desktop card the
  // details were squeezed into a ~275px column of hard-wrapped text beside an
  // empty half-card. Keeping the details OUT of that row is what fixes it, so
  // that is what this pins — a class assertion would just restate the JSX.
  it('renders the details below the action row, not as a flex sibling of it', async () => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
    api.getProviders.mockResolvedValue({
      providers: [{
        id: 'opencode-llama',
        name: 'OpenCode llama TUI',
        type: 'tui',
        command: 'opencode',
        args: [],
        enabled: true,
        defaultModel: 'dflash',
        tuiCommandLine: 'opencode',
      }],
      activeProvider: null,
    });

    renderPage();

    const deleteButton = await screen.findByRole('button', { name: 'Delete' });
    // The row that lays identity out against the actions — one level above the
    // button group the Delete button sits in.
    const headerRow = deleteButton.closest('.flex-wrap').parentElement;
    expect(headerRow.className).toContain('flex-row');
    expect(headerRow.textContent).toContain('OpenCode llama TUI');
    expect(headerRow.textContent).not.toContain('Command:');
    expect(headerRow.textContent).not.toContain('Default:');
  });
});

describe('vLLM-backed TUI provider', () => {
  const vllmTui = (overrides = {}) => ({
    id: 'opencode-vllm-tui',
    name: 'OpenCode vLLM TUI (Qwen3.8-27B)',
    type: 'tui',
    command: 'opencode',
    args: [],
    enabled: true,
    endpoint: 'http://127.0.0.1:18020/v1',
    models: ['qwen3.8-27b'],
    defaultModel: 'qwen3.8-27b',
    vllmBacked: true,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    api.getApps.mockResolvedValue([]);
    api.getProviderStatuses.mockResolvedValue({ providers: {} });
    api.getProviderRuntimes.mockResolvedValue({ runtimes: {} });
    api.getProviderReadiness.mockResolvedValue({ readiness: {} });
    localModels.value = { ctxById: {}, installed: { ollama: null, lmstudio: null } };
  });

  it('badges the card so the GPU-exclusive backend is visible at a glance', async () => {
    api.getProviders.mockResolvedValue({ providers: [vllmTui()], activeProvider: null });
    renderPage();
    expect(await screen.findByText('vLLM / DFLASH2')).toBeInTheDocument();
  });

  it('offers an API Key field on a TUI provider — the container is key-gated', async () => {
    api.getProviders.mockResolvedValue({ providers: [vllmTui()], activeProvider: null });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const key = await screen.findByLabelText('API Key');
    fireEvent.change(key, { target: { value: 'vllm-key-example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith(
      'opencode-vllm-tui',
      expect.objectContaining({ apiKey: 'vllm-key-example' }),
    ));
  });

  it('keeps the field off an unauthenticated local TUI backend', async () => {
    api.getProviders.mockResolvedValue({
      providers: [vllmTui({ id: 'opencode-mtplx-tui', name: 'OpenCode MTPLX TUI', vllmBacked: undefined, mtplxBacked: true })],
      activeProvider: null,
    });
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByDisplayValue('opencode');
    expect(screen.queryByLabelText('API Key')).toBeNull();
  });
});
