import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deriveProviderPreset: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../ui/Toast', () => ({ default: toast }));

import ProviderForm from './ProviderForm';

// Mounting the form on its own is the point of the extraction: the page-level
// suite has to stand up API + socket wiring to reach a single input, so the
// tab-state invariants below were previously unreachable in isolation.
const renderForm = (props = {}) => render(
  <MemoryRouter initialEntries={['/ai/new']}>
    <ProviderForm onClose={vi.fn()} onSave={vi.fn()} onEditProvider={vi.fn()} {...props} />
  </MemoryRouter>
);

const switchTab = (name) => fireEvent.click(screen.getByRole('tab', { name }));

describe('ProviderForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createProvider.mockResolvedValue({});
    api.updateProvider.mockResolvedValue({});
  });

  it('renders every editor tab', () => {
    renderForm();
    for (const label of ['Connection', 'Models', 'Generation', 'Environment']) {
      expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  // The Drawer body remounts per tab (key={currentTab}), so any field state left
  // inside a panel would be wiped on a tab switch. All of it is hoisted into the
  // form component above the Drawer — this is the regression guard for that.
  it('keeps entered values when a tab switch unmounts their fields', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });

    switchTab('Generation');
    expect(screen.queryByLabelText('Name *')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Planning Window'), { target: { value: '8192' } });

    switchTab('Connection');
    expect(screen.getByLabelText('Name *')).toHaveValue('Example Provider');

    switchTab('Generation');
    expect(screen.getByLabelText('Planning Window')).toHaveValue(8192);
  });

  // A number input on an unmounted tab is never validated by the browser, so
  // submit re-checks the ranges itself, jumps to the offending tab, and toasts.
  it('blocks submit on an out-of-range numeric field and reveals the tab that owns it', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'echo' } });

    switchTab('Generation');
    fireEvent.change(screen.getByLabelText('Planning Window'), { target: { value: '10' } });

    switchTab('Connection');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Planning Window must be between 512 and 2,097,152 tokens');
    });
    expect(api.createProvider).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Planning Window')).toBeInTheDocument();
  });
  it('saves an Ultra mapping after switching away from the Models tab', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'example-cli' } });
    switchTab('Models');
    fireEvent.change(screen.getByLabelText('Ultra (frontier)'), { target: { value: 'frontier-model' } });
    switchTab('Connection');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({ ultraModel: 'frontier-model' })));
  });

  it('explains the Claude credential path for a blank-command SGLang harness', () => {
    renderForm({ provider: { id: 'example-local', name: 'Example Local', type: 'tui', command: '', sglangBacked: true } });
    expect(screen.getByText('ANTHROPIC_AUTH_TOKEN')).toBeInTheDocument();
    expect(screen.queryByText(/It rides both the spawned OpenCode provider/)).not.toBeInTheDocument();
  });

  it('folds the credential-bootstrap fields into the nested shape the server expects', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Provider' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Setup Command'), { target: { value: 'npm install -g @your-org/token-cli' } });
    fireEvent.change(screen.getByLabelText('Bootstrap Command'), { target: { value: 'token-cli' } });
    fireEvent.change(screen.getByLabelText('Bootstrap Args'), { target: { value: 'run' } });
    fireEvent.change(screen.getByLabelText('Harness ID (optional)'), { target: { value: 'claude-code' } });
    fireEvent.change(screen.getByLabelText('Args Separator (optional)'), { target: { value: '--' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      credentialBootstrap: {
        setupCommand: 'npm install -g @your-org/token-cli',
        command: 'token-cli',
        args: ['run'],
        harnessId: 'claude-code',
        argsSeparator: '--',
      },
    })));
    // No flat scratch fields leak into the payload the server never declared.
    const [payload] = api.createProvider.mock.calls[0];
    expect(payload).not.toHaveProperty('credentialBootstrapCommand');
    expect(payload).not.toHaveProperty('credentialBootstrapArgs');
  });

  it('declares both execution modes from one create when the harness also runs as a TUI', async () => {
    // The whole point: one submit, one pair. Only what genuinely differs per
    // mode is declared — everything else on the body is shared, which is what
    // lets the server pair the two records as one harness.
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Agent' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'example' } });
    fireEvent.change(screen.getByLabelText('Arguments (space-separated)'), { target: { value: '--print' } });
    fireEvent.click(screen.getByLabelText(/also runs as a TUI/));
    fireEvent.change(screen.getByLabelText('TUI Arguments (space-separated)'), { target: { value: '--interactive' } });
    // The interactive mode's paste delay is the form's ONE such control,
    // revealed by the same checkbox rather than rendered a second time.
    fireEvent.change(screen.getByLabelText('Prompt Paste Delay (ms)'), { target: { value: '3000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createProvider).toHaveBeenCalled());
    const [payload] = api.createProvider.mock.calls[0];
    expect(payload.modes).toEqual({
      cli: {},
      tui: { args: ['--interactive'], tuiPromptDelayMs: 3000 },
    });
    // The body still describes the CLI record itself — its own `args` are the
    // CLI mode's, which is why `modes.cli` carries nothing — and the checkbox's
    // scratch state is not a provider field.
    expect(payload.type).toBe('cli');
    expect(payload.args).toEqual(['--print']);
    expect(payload).not.toHaveProperty('alsoTui');
    expect(payload).not.toHaveProperty('tuiArgs');
    expect(payload).not.toHaveProperty('tuiPromptDelayMs');
  });

  it('does not offer the pair control when editing an existing provider', () => {
    // Pairing describes two records being MINTED together; an existing
    // record's sibling is added from /ai/new like any other provider.
    renderForm({ provider: { id: 'example', name: 'Example', type: 'cli', command: 'example' } });
    expect(screen.queryByLabelText(/also runs as a TUI/)).not.toBeInTheDocument();
  });

  it('sends no modes on an ordinary single-mode create', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'Example Agent' } });
    fireEvent.change(screen.getByLabelText('Command *'), { target: { value: 'example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.createProvider).toHaveBeenCalled());
    expect(api.createProvider.mock.calls[0][0]).not.toHaveProperty('modes');
  });

  it('sends no credentialBootstrap key at all for an api-type provider', async () => {
    renderForm({
      provider: { id: 'example-api', name: 'Example API', type: 'api', endpoint: 'https://api.example.com/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The section is CLI/TUI-only, so an api save must not ship an explicit
    // `null` (which the server would merge onto the record as a literal null).
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    const [, payload] = api.updateProvider.mock.calls[0];
    expect(payload).not.toHaveProperty('credentialBootstrap');
  });

  it('clears a previously-set credential bootstrap when the Bootstrap Command is emptied', async () => {
    renderForm({
      provider: {
        id: 'example-bootstrap', name: 'Example Bootstrap', type: 'cli', command: 'claude',
        credentialBootstrap: { command: 'token-cli', args: ['run'] },
      },
    });
    fireEvent.change(screen.getByLabelText('Bootstrap Command'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // `null`, not omitted — an absent key means "unchanged" on a PATCH, which
    // would leave the stored bootstrap config in place after the user cleared it.
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalledWith('example-bootstrap', expect.objectContaining({
      credentialBootstrap: null,
    })));
  });
});

// #7447: this editor is the surface that literally names the budgeter
// ("Budgeter uses N"), so it must not contradict the card beside it — or the
// server that will enforce the number.
describe('ProviderForm planned context window', () => {
  const daemonProvider = {
    id: 'opencode-vllm',
    name: 'OpenCode vLLM',
    type: 'cli',
    command: 'opencode',
    endpoint: 'http://127.0.0.1:18020/v1',
    models: ['qwen3.8-27b'],
    defaultModel: 'qwen3.8-27b',
    // What a model refresh recorded whenever the user last pressed it.
    modelContextWindows: { 'qwen3.8-27b': 128000 },
    enabled: true,
  };

  const plannedContext = () => {
    switchTab('Generation');
    return screen.getByText(/Budgeter uses/).textContent;
  };

  it('names the window the daemon is serving now, not the stale catalog one', () => {
    renderForm({
      provider: daemonProvider,
      daemonReadiness: { contextWindows: { 'qwen3.8-27b': 32768 } },
    });
    expect(plannedContext()).toBe('Budgeter uses 32K ctx');
  });

  it('falls back to the recorded catalog window when the daemon says nothing', () => {
    renderForm({ provider: daemonProvider, daemonReadiness: { contextWindows: null } });
    expect(plannedContext()).toBe('Budgeter uses 128K ctx');
  });

  it('never writes the observed window back to the record on Save', async () => {
    // The hard constraint from #7441: the observation describes the process
    // running right now, so relaunching the daemon at a different `-c` would
    // make a persisted copy a lie. It reaches the display-only
    // `capabilityProvider` and must not ride a Save from there.
    renderForm({
      provider: daemonProvider,
      daemonReadiness: { contextWindows: { 'qwen3.8-27b': 32768 } },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    const [, payload] = api.updateProvider.mock.calls[0];
    expect(payload).not.toHaveProperty('modelContextWindows');
  });
});

describe('ProviderForm model access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.updateProvider.mockResolvedValue({});
  });

  // A scoped payload carries the narrowed list as `models` and the real one as
  // `modelCatalog`. The editor saves its model textarea verbatim, so seeding it
  // from `models` would let an unrelated edit persist the narrowed catalog over
  // the real one — silently, and recoverable only by a refresh.
  const scopedProvider = {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    type: 'api',
    endpoint: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct'],
    modelCatalog: ['meta/llama-3.3-70b-instruct', 'nvidia/nemotron-4-340b-instruct'],
    modelAccess: { mode: 'allow', patterns: ['meta/*'] },
    modelAccessHiddenCount: 1,
  };

  it('saves the full advertised catalog, not the scoped view', async () => {
    renderForm({ provider: scopedProvider });
    switchTab('Models');
    expect(screen.getByRole('textbox', { name: /Available Models/i }))
      .toHaveValue('meta/llama-3.3-70b-instruct, nvidia/nemotron-4-340b-instruct');

    fireEvent.click(screen.getByRole('button', { name: /Update Provider|Save/i }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    const [, payload] = api.updateProvider.mock.calls[0];
    expect(payload.models).toEqual(['meta/llama-3.3-70b-instruct', 'nvidia/nemotron-4-340b-instruct']);
    expect(payload.modelAccess).toEqual({ mode: 'allow', patterns: ['meta/*'] });
  });

  it('previews the scope live and ticks a model into the pattern list', async () => {
    renderForm({ provider: scopedProvider });
    switchTab('Models');
    expect(screen.getByText(/Showing 1 of 2 models \(1 hidden\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /nvidia\/nemotron-4-340b-instruct/ }));
    expect(screen.getByText(/Showing 2 of 2 models \(0 hidden\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Update Provider|Save/i }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    expect(api.updateProvider.mock.calls[0][1].modelAccess.patterns)
      .toEqual(['meta/*', 'nvidia/nemotron-4-340b-instruct']);
  });

  it('switching back to "all" parks the curated list rather than discarding it', async () => {
    // Re-opening a provider is a mode change, not a decision to throw away the
    // list the user assembled. The server reads mode `all` as unconstrained, so
    // the patterns ride along inert and are there when they scope it again.
    renderForm({ provider: scopedProvider });
    switchTab('Models');
    fireEvent.change(screen.getByRole('combobox', { name: /Model Access/i }),
      { target: { value: 'all' } });
    expect(screen.queryByText(/Showing 1 of 2 models/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Update Provider|Save/i }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    expect(api.updateProvider.mock.calls[0][1].modelAccess).toEqual({ mode: 'all', patterns: ['meta/*'] });
  });

  it('a provider that never had a policy sends an explicit null, not an omitted key', async () => {
    // The server merges a PATCH by spread, so an omitted key reads as
    // "unchanged" — a cleared policy has to arrive as a value.
    renderForm({ provider: { ...scopedProvider, modelAccess: undefined, modelCatalog: undefined } });
    switchTab('Models');
    fireEvent.click(screen.getByRole('button', { name: /Update Provider|Save/i }));
    await waitFor(() => expect(api.updateProvider).toHaveBeenCalled());
    expect(api.updateProvider.mock.calls[0][1].modelAccess).toBeNull();
  });

  it('says so when a mode is selected but nothing is scoped yet', () => {
    // "Not configured yet" must not read as a working policy — the count line
    // would otherwise reassure with "Showing 2 of 2".
    renderForm({ provider: { ...scopedProvider, modelAccess: { mode: 'allow', patterns: [] } } });
    switchTab('Models');
    expect(screen.getByText(/No patterns yet/)).toBeInTheDocument();
  });

  // #7565: a DERIVED preset says where its connection comes from; a legacy one
  // the server reports convertible offers the one-click conversion and closes
  // through onSave like any other save. Neither appears on a new record.
  describe('preset structure', () => {
    const legacy = { id: 'claude-local', name: 'Claude', type: 'cli', command: 'claude', presetKind: 'legacy', presetDerivable: true };

    it('explains a derived preset, links its service, hides the connection-owned fields and offers no conversion', () => {
      renderForm({ provider: { ...legacy, presetKind: 'derived', presetDerivable: false, harnessId: 'claude', method: 'cli', serviceId: 'ollama' } });
      expect(screen.getByText(/Derived from service/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'ollama' })).toHaveAttribute('href', '/ai/services/ollama');
      expect(screen.queryByRole('button', { name: /Convert to derived preset/ })).not.toBeInTheDocument();
      // The service owns type, command and the inline bootstrap (#7567); the
      // preset keeps its name and arguments.
      expect(screen.queryByLabelText('Type *')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Command *')).not.toBeInTheDocument();
      expect(screen.queryByText('Credential Bootstrap (optional)')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Name *')).toHaveValue('Claude');
      expect(screen.getByLabelText('Arguments (space-separated)')).toBeInTheDocument();
    });

    it('hides the endpoint and key of a derived API preset, keeping them on a legacy one', () => {
      const apiRecord = { id: 'nvidia', name: 'NVIDIA', type: 'api', endpoint: 'https://integrate.api.nvidia.com/v1', presetKind: 'legacy', presetDerivable: false };
      const { unmount } = renderForm({ provider: apiRecord });
      expect(screen.getByLabelText('Endpoint *')).toHaveValue('https://integrate.api.nvidia.com/v1');
      expect(screen.getByLabelText('API Key')).toBeInTheDocument();
      unmount();
      renderForm({ provider: { ...apiRecord, presetKind: 'derived', harnessId: 'direct', method: 'api', serviceId: 'nvidia-nim' } });
      expect(screen.queryByLabelText('Endpoint *')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('API Key')).not.toBeInTheDocument();
    });

    it('converts a derivable legacy preset through the API and hands back to the page', async () => {
      const onSave = vi.fn();
      api.deriveProviderPreset.mockResolvedValue({ ...legacy, presetKind: 'derived', serviceId: 'ollama' });
      renderForm({ provider: legacy, onSave });
      fireEvent.click(screen.getByRole('button', { name: /Convert to derived preset/ }));
      await waitFor(() => expect(onSave).toHaveBeenCalled());
      expect(api.deriveProviderPreset).toHaveBeenCalledWith('claude-local');
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('ollama'));
    });

    it('offers nothing on a record the server does not report convertible, nor on a new one', () => {
      renderForm({ provider: { ...legacy, presetDerivable: false } });
      expect(screen.queryByRole('button', { name: /Convert to derived preset/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Derived from service/)).not.toBeInTheDocument();
    });
  });
});
